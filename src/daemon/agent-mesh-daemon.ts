import type { JsonRpcRequest } from "../channel-rpc/json-rpc";
import { ConfigStore } from "../config/store";
import { appServerSocketPath } from "../config/paths";
import type { AgentMeshConfig, LaneConfig } from "../config/types";
import { LaneController } from "../lane/lane-controller";
import { LaneHubConnection } from "../hub/lane-hub-connection";
import { SecretStore } from "../config/secrets";
import { HostDaemon } from "./host-daemon";
import { RuntimeWorker } from "../runtime/worker";
import { createRuntimeAdapter } from "../runtime/factory";
import type { RuntimeTurn } from "../runtime/inbox";
import { ClaudeSupervisor } from "../runtime/claude-supervisor";
import { ChannelProcessSupervisor } from "../channel-driver/supervisor";

export interface AgentMeshDaemonOptions {
  configFile: string;
  stateDirectory: string;
  runtimeDirectory: string;
  secretDirectory: string;
  onDiagnostic?: (message: string, error?: unknown) => void;
}

/**
 * What a runtime with no resident process is doing, read from its queue.
 *
 * `running` has to be reachable: a lane mid-turn previously reported `idle`,
 * because the state was derived from the first PENDING turn and claiming one
 * clears that. Idle then covered both "nothing to do" and "working", which
 * are the two things an operator is trying to tell apart.
 */
function turnDrivenRuntimeState(controller: LaneController | undefined): { state: string } {
  const counts = controller?.runtimeInbox.countsByState() ?? {};
  if ((counts.RUNNING ?? 0) > 0) return { state: "running" };
  if ((counts.PENDING ?? 0) > 0) return { state: "queued" };
  return { state: "idle" };
}

export class AgentMeshDaemon {
  readonly configStore: ConfigStore;
  readonly host: HostDaemon;
  readonly #stateDirectory: string;
  readonly #controllers = new Map<string, LaneController>();
  readonly #hubConnections = new Map<string, LaneHubConnection>();
  readonly #runtimeWorkers = new Map<string, RuntimeWorker>();
  readonly #claudeSupervisors = new Map<string, ClaudeSupervisor>();
  readonly #channelSupervisors = new Map<string, ChannelProcessSupervisor>();
  readonly #secrets: SecretStore;
  readonly #onDiagnostic: (message: string, error?: unknown) => void;
  readonly #runtimeDirectory: string;
  readonly #secretDirectory: string;
  readonly #configFile: string;
  #config: AgentMeshConfig | null = null;
  #deliveryTimer: ReturnType<typeof setInterval> | null = null;
  #deliveryDrainRunning = false;

  constructor(options: AgentMeshDaemonOptions) {
    this.configStore = new ConfigStore(options.configFile);
    this.#stateDirectory = options.stateDirectory;
    this.#runtimeDirectory = options.runtimeDirectory;
    this.#secretDirectory = options.secretDirectory;
    this.#configFile = options.configFile;
    this.#secrets = new SecretStore(options.secretDirectory);
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.host = new HostDaemon({
      runtimeDirectory: options.runtimeDirectory,
      createLaneHandler: (laneId) => this.#controllers.get(laneId)?.channelHandler,
      onControlRequest: (request) => this.#handleControl(request),
      ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    });
  }

  async start(): Promise<void> {
    const config = await this.configStore.load();
    this.#config = config;
    for (const lane of config.lanes.filter((item) => item.enabled)) {
      await this.#createController(lane);
    }
    await this.host.start([...this.#controllers.keys()]);
    for (const controller of this.#controllers.values()) {
      this.#startRuntimeWorker(controller);
      await this.#startClaudeSupervisor(controller);
      this.#startChannelSupervisors(controller);
    }
    this.#deliveryTimer = setInterval(() => void this.#drainPendingDeliveries(), 1_000);
  }

  async stop(): Promise<void> {
    if (this.#deliveryTimer) clearInterval(this.#deliveryTimer);
    this.#deliveryTimer = null;
    await Promise.allSettled(
      [...this.#runtimeWorkers.values()].map((worker) => worker.stop()),
    );
    this.#runtimeWorkers.clear();
    await Promise.allSettled(
      [...this.#claudeSupervisors.values()].map((supervisor) => supervisor.stop()),
    );
    this.#claudeSupervisors.clear();
    await Promise.allSettled(
      [...this.#channelSupervisors.values()].map((supervisor) => supervisor.stop()),
    );
    this.#channelSupervisors.clear();
    await this.host.stop();
    await Promise.allSettled(
      [...this.#hubConnections.values()].map((connection) => connection.stop()),
    );
    this.#hubConnections.clear();
    for (const controller of this.#controllers.values()) controller.close();
    this.#controllers.clear();
  }

  async reload(): Promise<{ revision: number; lanes: string[] }> {
    const next = await this.configStore.load();
    const hubChanged = JSON.stringify(next.hub) !== JSON.stringify(this.#config?.hub ?? null);
    const wanted = new Map(
      next.lanes.filter((lane) => lane.enabled).map((lane) => [lane.id, lane]),
    );
    for (const [laneId, controller] of [...this.#controllers]) {
      const replacement = wanted.get(laneId);
      const currentCore = { ...controller.config, channels: [] };
      const replacementCore = replacement ? { ...replacement, channels: [] } : null;
      if (
        hubChanged ||
        !replacement ||
        JSON.stringify(replacementCore) !== JSON.stringify(currentCore)
      ) {
        const worker = this.#runtimeWorkers.get(laneId);
        if (worker) await worker.stop();
        this.#runtimeWorkers.delete(laneId);
        const supervisor = this.#claudeSupervisors.get(laneId);
        if (supervisor) await supervisor.stop();
        this.#claudeSupervisors.delete(laneId);
        for (const [channelId, channelSupervisor] of [...this.#channelSupervisors]) {
          if (channelSupervisor.lane.id === laneId) {
            await channelSupervisor.stop();
            this.#channelSupervisors.delete(channelId);
          }
        }
        await this.host.removeLane(laneId);
        const hub = this.#hubConnections.get(laneId);
        if (hub) await hub.stop();
        this.#hubConnections.delete(laneId);
        controller.close();
        this.#controllers.delete(laneId);
      }
    }
    this.#config = next;
    for (const [laneId, lane] of wanted) {
      if (!this.#controllers.has(laneId)) {
        await this.#createController(lane);
        await this.host.addLane(laneId);
        this.#startRuntimeWorker(this.#controllers.get(laneId)!);
        await this.#startClaudeSupervisor(this.#controllers.get(laneId)!);
        this.#startChannelSupervisors(this.#controllers.get(laneId)!);
      } else {
        await this.#syncChannelSupervisors(this.#controllers.get(laneId)!, lane);
      }
    }
    return { revision: next.revision, lanes: [...this.#controllers.keys()] };
  }

  async #createController(config: LaneConfig): Promise<LaneController> {
    const controller = new LaneController({
      config,
      stateRoot: this.#stateDirectory,
    });
    await controller.initialize();
    this.#controllers.set(config.id, controller);
    if (this.#config?.hub) {
      const connection = new LaneHubConnection(
        config,
        this.#config.hub,
        controller.outbox,
        this.#secrets,
      );
      this.#hubConnections.set(config.id, connection);
      connection.start();
      connection.onMessage((message) => {
        controller.runtimeInbox.enqueueMesh(message);
      });
    }
    return controller;
  }

  #startRuntimeWorker(controller: LaneController): void {
    if (this.#runtimeWorkers.has(controller.config.id)) return;
    if (controller.config.runtime.kind === "claude") return;
    const adapter = createRuntimeAdapter(
      controller.config.runtime,
      this.#onDiagnostic,
      // Codex only: the app-server listens on this path so `agent-mesh attach`
      // can point a `codex --remote` TUI at the session the daemon is driving.
      controller.config.runtime.kind === "codex"
        ? appServerSocketPath(this.#runtimeDirectory, controller.config.id)
        : undefined,
    );
    const worker = new RuntimeWorker({
      laneId: controller.config.id,
      config: controller.config.runtime,
      inbox: controller.runtimeInbox,
      adapter,
      reply: async (turn, response) => this.#reply(controller, turn, response),
      onDiagnostic: this.#onDiagnostic,
    });
    this.#runtimeWorkers.set(controller.config.id, worker);
    worker.start();
  }

  /**
   * @param resume defaults to continuing the previous conversation. Every
   *   caller here is the daemon restoring a lane -- boot, config reload,
   *   re-enable -- and none of those are a decision to forget. A mesh peer
   *   addresses this agent by identity, so a lane that comes back empty is a
   *   stranger answering to the name it was talking to. Only `runtime.start`
   *   passes false, and only because an operator asked for a clean session.
   */
  async #startClaudeSupervisor(controller: LaneController, resume = true): Promise<void> {
    if (controller.config.runtime.kind !== "claude") return;
    const supervisor = new ClaudeSupervisor({
      lane: controller.config,
      stateDirectory: controller.stateDirectory,
      runtimeDirectory: this.#runtimeDirectory,
      configFile: this.#configFile,
      secretDirectory: this.#secretDirectory,
    });
    this.#claudeSupervisors.set(controller.config.id, supervisor);
    await supervisor.start(resume).catch((error) =>
      this.#onDiagnostic(
        `Claude runtime did not start for lane ${controller.config.id}`,
        error,
      ),
    );
  }

  #startChannelSupervisors(controller: LaneController): void {
    for (const channel of controller.config.channels.filter((item) => item.enabled)) {
      const supervisor = new ChannelProcessSupervisor(
        controller.config,
        channel,
        {
          configFile: this.#configFile,
          stateRoot: this.#stateDirectory,
          runtimeDirectory: this.#runtimeDirectory,
          secretDirectory: this.#secretDirectory,
        },
      );
      this.#channelSupervisors.set(channel.id, supervisor);
      supervisor.start();
    }
  }

  async #syncChannelSupervisors(
    controller: LaneController,
    replacement: LaneConfig,
  ): Promise<void> {
    const next = new Map(replacement.channels.map((channel) => [channel.id, channel]));
    for (const [channelId, supervisor] of [...this.#channelSupervisors]) {
      if (supervisor.lane.id !== controller.config.id) continue;
      const wanted = next.get(channelId);
      if (
        !wanted?.enabled ||
        JSON.stringify(wanted) !== JSON.stringify(supervisor.channel)
      ) {
        await supervisor.stop();
        this.#channelSupervisors.delete(channelId);
      }
    }
    controller.updateChannels(replacement.channels);
    for (const channel of replacement.channels.filter((item) => item.enabled)) {
      if (this.#channelSupervisors.has(channel.id)) continue;
      const supervisor = new ChannelProcessSupervisor(
        controller.config,
        channel,
        {
          configFile: this.#configFile,
          stateRoot: this.#stateDirectory,
          runtimeDirectory: this.#runtimeDirectory,
          secretDirectory: this.#secretDirectory,
        },
      );
      this.#channelSupervisors.set(channel.id, supervisor);
      supervisor.start();
    }
  }

  async #reply(
    controller: LaneController,
    turn: RuntimeTurn,
    response: string,
  ): Promise<void> {
    if (turn.sourceKind === "mesh") {
      const to = turn.correlation.from;
      const replyTo = turn.correlation.reply_to;
      if (typeof to !== "string" || typeof replyTo !== "string") {
        throw new Error("Mesh turn has invalid immutable correlation");
      }
      const connection = this.#hubConnections.get(controller.config.id);
      if (!connection) throw new Error("Hub connection is unavailable");
      await connection.send(to, response, replyTo, `runtime-${turn.turnId}`);
      return;
    }

    const driverInstanceId = turn.correlation.driver_instance_id;
    const accountRef = turn.correlation.account_ref;
    const conversationRef = turn.correlation.conversation_ref;
    const threadRef = turn.correlation.thread_ref;
    const replyTo = turn.correlation.reply_to_provider_message_id;
    if (
      typeof driverInstanceId !== "string" ||
      typeof accountRef !== "string" ||
      typeof conversationRef !== "string" ||
      typeof replyTo !== "string"
    ) {
      throw new Error("Channel turn has invalid immutable correlation");
    }
    const actionId = `act-${turn.turnId}`;
    const params = {
      driver_instance_id: driverInstanceId,
      action_id: actionId,
      conversation: {
        account_ref: accountRef,
        conversation_ref: conversationRef,
        thread_ref: typeof threadRef === "string" ? threadRef : null,
      },
      reply_to_provider_message_id: replyTo,
      text: response,
      attachments: [],
    };
    await controller.outbox.record({
      direction: "outbound",
      sourceKind: "channel",
      driverInstanceId,
      rawParams: params,
      attachments: [],
      correlation: {
        audit_event_type: "channel.outbound.requested",
        driver_instance_id: driverInstanceId,
        account_ref: accountRef,
        conversation_ref: conversationRef,
        thread_ref: typeof threadRef === "string" ? threadRef : null,
        reply_to_provider_message_id: replyTo,
      },
      dedupKey: `runtime-reply:${turn.turnId}`,
    });
    const reserved = controller.outbox.reserveAction(actionId, driverInstanceId, params);
    if (reserved.duplicate && reserved.result !== null) {
      await this.#completeChannelAction(
        controller,
        actionId,
        params,
        reserved.result,
      );
      return;
    }
    const laneServer = this.host.getLane(controller.config.id);
    if (!laneServer) throw new Error("Lane channel server is unavailable");
    const result = await laneServer.requestDriver(
      driverInstanceId,
      "channel.message.send",
      params,
    );
    await this.#completeChannelAction(controller, actionId, params, result);
  }

  async #completeChannelAction(
    controller: LaneController,
    actionId: string,
    request: Record<string, unknown>,
    result: unknown,
  ): Promise<void> {
    controller.outbox.completeAction(actionId, result);
    await controller.outbox.record({
      direction: "outbound",
      sourceKind: "channel",
      ...(typeof request.driver_instance_id === "string"
        ? { driverInstanceId: request.driver_instance_id }
        : {}),
      rawParams: { request, result },
      attachments: [],
      correlation: {
        audit_event_type: "channel.outbound.succeeded",
        action_id: actionId,
      },
      dedupKey: `delivery-success:${actionId}`,
    });
    if (actionId.startsWith("act-turn_")) {
      const turnId = actionId.slice(4);
      const turn = controller.runtimeInbox.get(turnId);
      if (turn && turn.state !== "COMPLETED" && typeof request.text === "string") {
        controller.runtimeInbox.complete(turnId, request.text);
      }
    }
  }

  async #drainPendingDeliveries(): Promise<void> {
    if (this.#deliveryDrainRunning) return;
    this.#deliveryDrainRunning = true;
    try {
      for (const supervisor of this.#channelSupervisors.values()) {
        supervisor.maintain();
      }
      for (const controller of this.#controllers.values()) {
        const laneServer = this.host.getLane(controller.config.id);
        if (!laneServer) continue;
        for (const action of controller.outbox.listPendingActions(Date.now() - 5_000)) {
          if (!laneServer.getDriver(action.driverInstanceId)) continue;
          try {
            const result = await laneServer.requestDriver(
              action.driverInstanceId,
              "channel.message.send",
              action.request,
            );
            await this.#completeChannelAction(
              controller,
              action.actionId,
              action.request,
              result,
            );
          } catch (error) {
            this.#onDiagnostic(
              `Channel delivery retry failed for ${action.actionId}`,
              error,
            );
          }
        }
      }
    } finally {
      this.#deliveryDrainRunning = false;
    }
  }

  async #handleControl(request: JsonRpcRequest): Promise<unknown> {
    switch (request.method) {
      case "config.reload":
        return await this.reload();
      case "daemon.shutdown":
        setTimeout(() => process.kill(process.pid, "SIGTERM"), 50).unref();
        return { stopping: true, pid: process.pid };
      case "config.get":
        return this.#config;
      case "lane.list":
        return await Promise.all(
          (this.#config?.lanes ?? []).map(async (lane) => {
            const controller = this.#controllers.get(lane.id);
            return {
              lane_id: lane.id,
              identity: lane.identity,
              enabled: lane.enabled,
              runtime: lane.runtime.kind,
              outbox: controller
                ? await controller.outbox.summary()
                : { pending: 0, retry: 0, deadLetter: 0, warning: false },
              hub: this.#hubConnections.get(lane.id)?.status ?? null,
              // Claude reports through its supervisor because a CLI in tmux
              // has states a queue does not -- stopped, awaiting-input. The
              // others have no resident process, so what they are doing is
              // what their turns are doing.
              runtime_status: !lane.enabled
                ? { state: "disabled" }
                : this.#claudeSupervisors.get(lane.id)?.status ??
                  turnDrivenRuntimeState(controller),
              channels: lane.channels.map((channel) => ({
                id: channel.id,
                provider: channel.provider,
                enabled: channel.enabled,
                status: this.#channelSupervisors.get(channel.id)?.status ?? {
                  state: channel.enabled ? "stopped" : "disabled",
                },
              })),
            };
          }),
        );
      case "outbox.summary": {
        const params = request.params as { lane_id?: unknown } | undefined;
        if (typeof params?.lane_id !== "string") throw new Error("lane_id is required");
        const controller = this.#controllers.get(params.lane_id);
        if (!controller) throw new Error(`Unknown lane: ${params.lane_id}`);
        return await controller.outbox.summary();
      }
      case "outbox.replay": {
        const params = request.params as
          | { lane_id?: unknown; event_ids?: unknown }
          | undefined;
        if (typeof params?.lane_id !== "string") throw new Error("lane_id is required");
        const controller = this.#controllers.get(params.lane_id);
        if (!controller) throw new Error(`Unknown lane: ${params.lane_id}`);
        const eventIds = params.event_ids;
        if (
          eventIds !== undefined &&
          (!Array.isArray(eventIds) || eventIds.some((id) => typeof id !== "string"))
        ) {
          throw new Error("event_ids must be an array of strings");
        }
        const result = controller.outbox.replayDeadLetters(eventIds as string[] | undefined);
        // The worker sleeps a second between empty passes; without this the
        // replayed events sit until that timer expires even though the queue
        // already has them.
        this.#hubConnections.get(params.lane_id)?.auditWorker.poke();
        return {
          lane_id: params.lane_id,
          replayed: result.replayed.length,
          skipped: result.skipped.length,
          event_ids: result.replayed,
          outbox: await controller.outbox.summary(),
        };
      }
      case "hub.status":
        return [...this.#hubConnections.entries()].map(([laneId, connection]) => ({
          lane_id: laneId,
          ...connection.status,
        }));
      case "mesh.send": {
        const params = request.params as
          | {
              lane_id?: unknown;
              to?: unknown;
              content?: unknown;
              reply_to?: unknown;
              client_message_id?: unknown;
            }
          | undefined;
        if (
          typeof params?.lane_id !== "string" ||
          typeof params.to !== "string" ||
          typeof params.content !== "string"
        ) {
          throw new Error("lane_id, to and content are required");
        }
        const connection = this.#hubConnections.get(params.lane_id);
        if (!connection) throw new Error(`Lane has no Hub connection: ${params.lane_id}`);
        const replyTo =
          typeof params.reply_to === "string" || params.reply_to === null
            ? params.reply_to
            : undefined;
        const clientMessageId =
          typeof params.client_message_id === "string"
            ? params.client_message_id
            : undefined;
        return await connection.send(
          params.to,
          params.content,
          replyTo,
          clientMessageId,
        );
      }
      case "mesh.list_agents": {
        const params = request.params as { lane_id?: unknown } | undefined;
        if (typeof params?.lane_id !== "string") throw new Error("lane_id is required");
        const connection = this.#hubConnections.get(params.lane_id);
        if (!connection) throw new Error(`Lane has no Hub connection: ${params.lane_id}`);
        return await connection.mesh.listAgents();
      }
      case "mesh.inbox": {
        const params = request.params as { lane_id?: unknown; limit?: unknown } | undefined;
        if (typeof params?.lane_id !== "string") throw new Error("lane_id is required");
        const controller = this.#controllers.get(params.lane_id);
        if (!controller) throw new Error(`Unknown lane: ${params.lane_id}`);
        const limit =
          typeof params.limit === "number" && Number.isSafeInteger(params.limit)
            ? Math.max(1, Math.min(500, params.limit))
            : 50;
        return controller.runtimeInbox.list(limit);
      }
      case "runtime.start": {
        const params = request.params as
          | { lane_id?: unknown; resume?: unknown }
          | undefined;
        if (typeof params?.lane_id !== "string") throw new Error("lane_id is required");
        const controller = this.#controllers.get(params.lane_id);
        if (!controller) throw new Error(`Unknown lane: ${params.lane_id}`);
        if (controller.config.runtime.kind !== "claude") {
          throw new Error("Only Claude lanes hold a session that can be restarted");
        }
        // A session someone exited is gone, not stopped: tmux keeps nothing to
        // reattach to. Rebuilding it is what "attach" has to mean at that
        // point, and the caller decides whether the CLI continues its previous
        // conversation or starts an empty one.
        const existing = this.#claudeSupervisors.get(params.lane_id);
        if (existing) await existing.stop();
        this.#claudeSupervisors.delete(params.lane_id);
        await this.#startClaudeSupervisor(controller, params.resume === true);
        return {
          lane_id: params.lane_id,
          runtime: this.#claudeSupervisors.get(params.lane_id)?.status ?? null,
        };
      }
      case "runtime.observe": {
        const params = request.params as { lane_id?: unknown; limit?: unknown } | undefined;
        if (typeof params?.lane_id !== "string") throw new Error("lane_id is required");
        const controller = this.#controllers.get(params.lane_id);
        if (!controller) throw new Error(`Unknown lane: ${params.lane_id}`);
        const limit =
          typeof params.limit === "number" && Number.isSafeInteger(params.limit)
            ? Math.max(1, Math.min(200, params.limit))
            : 20;
        // Redacted here rather than in the renderer. An observer is watched by
        // whoever can see the terminal, and prompt bodies, model output and
        // auth codes are exactly what must not be on that screen -- so they
        // never leave the daemon, and a bug in the renderer cannot leak them.
        return {
          lane_id: params.lane_id,
          runtime: controller.config.runtime.kind,
          workspace: controller.config.runtime.workspace,
          turns: controller.runtimeInbox.list(limit).map((turn) => ({
            turn_id: turn.turnId,
            source_kind: turn.sourceKind,
            from: typeof turn.correlation.from === "string" ? turn.correlation.from : null,
            state: turn.state,
            prompt_chars: turn.content.length,
            response_chars: turn.response?.length ?? null,
            error_code: turn.errorCode,
            created_at: turn.createdAt,
            updated_at: turn.updatedAt,
          })),
        };
      }
      case "runtime.claim": {
        const params = request.params as { lane_id?: unknown } | undefined;
        if (typeof params?.lane_id !== "string") throw new Error("lane_id is required");
        const controller = this.#controllers.get(params.lane_id);
        if (!controller) throw new Error(`Unknown lane: ${params.lane_id}`);
        if (controller.config.runtime.kind !== "claude") {
          throw new Error("runtime.claim is reserved for Claude channel lanes");
        }
        return controller.runtimeInbox.claimNext();
      }
      case "runtime.reply": {
        const params = request.params as
          | { lane_id?: unknown; turn_id?: unknown; text?: unknown }
          | undefined;
        if (
          typeof params?.lane_id !== "string" ||
          typeof params.turn_id !== "string" ||
          typeof params.text !== "string" ||
          !params.text.trim()
        ) {
          throw new Error("lane_id, turn_id and non-empty text are required");
        }
        const controller = this.#controllers.get(params.lane_id);
        if (!controller) throw new Error(`Unknown lane: ${params.lane_id}`);
        const turn = controller.runtimeInbox.get(params.turn_id);
        if (!turn) throw new Error(`Unknown runtime turn: ${params.turn_id}`);
        if (turn.state === "COMPLETED") {
          return { duplicate: true, response: turn.response };
        }
        if (turn.state !== "RUNNING") {
          throw new Error(`Runtime turn is not active: ${turn.state}`);
        }
        await this.#reply(controller, turn, params.text);
        controller.runtimeInbox.complete(turn.turnId, params.text);
        return { duplicate: false, turn_id: turn.turnId };
      }
      case "runtime.fail": {
        const params = request.params as
          | { lane_id?: unknown; turn_id?: unknown; code?: unknown }
          | undefined;
        if (
          typeof params?.lane_id !== "string" ||
          typeof params.turn_id !== "string" ||
          typeof params.code !== "string"
        ) {
          throw new Error("lane_id, turn_id and code are required");
        }
        const controller = this.#controllers.get(params.lane_id);
        if (!controller) throw new Error(`Unknown lane: ${params.lane_id}`);
        controller.runtimeInbox.fail(params.turn_id, params.code);
        return { ok: true };
      }
      default:
        throw new Error(`Unsupported control method: ${request.method}`);
    }
  }
}
