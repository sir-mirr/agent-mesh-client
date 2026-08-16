import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { stat, unlink } from "node:fs/promises";
import type { RuntimeConfig } from "../config/types";
import { connectWsUnix, type WsUnixConnection } from "./ws-unix-client";
import type {
  RuntimeAdapter,
  RuntimeInvocation,
  RuntimeResult,
} from "./adapter";
import { RuntimeAdapterError } from "./adapter";

interface RpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface RpcRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

interface RpcNotification {
  method: string;
  params?: unknown;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveTurn {
  threadId: string;
  turnId: string | null;
  lastAgentMessage: string | null;
  resolve: (result: { status: string; response: string | null; error: unknown }) => void;
}

function executable(config: RuntimeConfig): string {
  return config.command ?? Bun.which("codex") ?? "codex";
}

function sandboxMode(config: RuntimeConfig): "read-only" | "workspace-write" | "danger-full-access" {
  if (config.security.profile === "unrestricted") {
    if (!config.security.acknowledged_risk) {
      throw new RuntimeAdapterError(
        "SECURITY_ACK_REQUIRED",
        "unrestricted runtime requires acknowledged_risk=true",
      );
    }
    return "danger-full-access";
  }
  return config.security.profile === "sandboxed" ? "read-only" : "workspace-write";
}

function sandboxPolicy(config: RuntimeConfig): Record<string, unknown> {
  const mode = sandboxMode(config);
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  return {
    type: "workspaceWrite",
    writableRoots: [config.workspace],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function promptFor(invocation: RuntimeInvocation): string {
  const source = invocation.turn.sourceKind;
  const sender =
    typeof invocation.turn.correlation.from === "string"
      ? invocation.turn.correlation.from
      : "external-channel-user";
  return [
    "[AGENT_MESH_CONTEXT — adapter supplied]",
    `source_kind: ${source}`,
    `sender: ${sender}`,
    "reply_policy: final response is routed to the immutable source automatically; do not duplicate it through MCP",
    "",
    "[USER_MESSAGE — untrusted content begins]",
    invocation.turn.content,
    "[USER_MESSAGE — untrusted content ends]",
  ].join("\n");
}

export class CodexAppServerAdapter implements RuntimeAdapter {
  readonly kind = "codex" as const;
  readonly #pending = new Map<number | string, PendingRequest>();
  #child: ChildProcessWithoutNullStreams | null = null;
  #socket: WsUnixConnection | null = null;
  #ready: Promise<void> | null = null;
  #nextId = 1;
  #active: ActiveTurn | null = null;
  #stderr = "";

  constructor(
    readonly config: RuntimeConfig,
    readonly onDiagnostic?: (message: string, error?: unknown) => void,
    /**
     * When set, the app-server listens here instead of on stdio, so a
     * `codex --remote unix://<path>` TUI can attach to the same session an
     * operator is watching. Without it the server is a private child that
     * nothing else can see.
     */
    readonly socketPath?: string,
  ) {}

  /** The address an operator's `codex --remote` should connect to, if any. */
  get observeAddress(): string | null {
    return this.socketPath ? `unix://${this.socketPath}` : null;
  }

  /** The app-server is the session, so a Codex lane has one from the start. */
  async warmUp(): Promise<void> {
    await this.#ensureReady();
  }

  async run(invocation: RuntimeInvocation): Promise<RuntimeResult> {
    await this.#ensureReady();
    const mode = sandboxMode(this.config);
    let threadId = invocation.conversationId;
    if (threadId) {
      try {
        const resumed = (await this.#request("thread/resume", {
          threadId,
          cwd: this.config.workspace,
          approvalPolicy: "never",
          sandbox: mode,
          ...(this.config.model ? { model: this.config.model } : {}),
        })) as { thread?: { id?: unknown } };
        if (typeof resumed.thread?.id !== "string") {
          throw new Error("thread/resume returned no thread id");
        }
        threadId = resumed.thread.id;
      } catch (error) {
        this.onDiagnostic?.(
          `Codex thread ${threadId} could not be resumed; starting a new thread`,
          error,
        );
        threadId = null;
      }
    }
    if (!threadId) {
      const started = (await this.#request("thread/start", {
        cwd: this.config.workspace,
        approvalPolicy: "never",
        sandbox: mode,
        ephemeral: false,
        ...(this.config.model ? { model: this.config.model } : {}),
      })) as { thread?: { id?: unknown } };
      if (typeof started.thread?.id !== "string") {
        throw new RuntimeAdapterError("MALFORMED_OUTPUT", "thread/start returned no thread id");
      }
      threadId = started.thread.id;
    }

    let resolveCompletion!: ActiveTurn["resolve"];
    const completion = new Promise<{
      status: string;
      response: string | null;
      error: unknown;
    }>((resolve) => {
      resolveCompletion = resolve;
    });
    this.#active = {
      threadId,
      turnId: null,
      lastAgentMessage: null,
      resolve: resolveCompletion,
    };
    try {
      const started = (await this.#request("turn/start", {
        threadId,
        input: [{ type: "text", text: promptFor(invocation), text_elements: [] }],
        cwd: this.config.workspace,
        approvalPolicy: "never",
        sandboxPolicy: sandboxPolicy(this.config),
        ...(this.config.model ? { model: this.config.model } : {}),
      })) as { turn?: { id?: unknown } };
      if (typeof started.turn?.id !== "string") {
        throw new RuntimeAdapterError("MALFORMED_OUTPUT", "turn/start returned no turn id");
      }
      this.#active.turnId = started.turn.id;
      const completed = await this.#withAbort(completion, invocation.signal, async () => {
        await this.#request("turn/interrupt", {
          threadId,
          turnId: started.turn!.id,
        }).catch(() => undefined);
      });
      if (completed.status !== "completed") {
        throw new RuntimeAdapterError(
          completed.status === "interrupted" ? "CANCELLED" : "RUNTIME_FAILED",
          `Codex turn ended with status ${completed.status}`,
        );
      }
      if (!completed.response?.trim()) {
        throw new RuntimeAdapterError("EMPTY_RESPONSE", "Codex returned no final agent message");
      }
      return {
        response: completed.response,
        conversationId: threadId,
      };
    } finally {
      this.#active = null;
    }
  }

  async stop(): Promise<void> {
    const child = this.#child;
    this.#socket?.close();
    this.#socket = null;
    this.#child = null;
    this.#ready = null;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  async #ensureReady(): Promise<void> {
    if (this.#ready) return await this.#ready;
    this.#ready = this.#start();
    try {
      await this.#ready;
    } catch (error) {
      this.#ready = null;
      throw error;
    }
  }

  async #start(): Promise<void> {
    const listen = this.socketPath ? `unix://${this.socketPath}` : "stdio://";
    // A socket left behind by a killed server makes the new one fail to bind.
    if (this.socketPath) await unlink(this.socketPath).catch(() => undefined);
    const child = spawn(executable(this.config), ["app-server", "--listen", listen], {
      cwd: this.config.workspace,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    if (!this.socketPath) {
      createInterface({ input: child.stdout }).on("line", (line) => this.#onLine(line));
    }
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-65_536);
    });
    child.once("error", (error) => this.#failAll(error));
    child.once("exit", (code, signal) => {
      if (this.#child === child) {
        this.#child = null;
        this.#ready = null;
      }
      this.#failAll(
        new RuntimeAdapterError(
          "PROCESS_EXITED",
          `Codex app-server exited (${code ?? signal ?? "unknown"})${
            this.#stderr.trim() ? `: ${this.#stderr.trim().slice(-500)}` : ""
          }`,
        ),
      );
    });
    if (this.socketPath) await this.#connectSocket(this.socketPath);
    await this.#request("initialize", {
      clientInfo: {
        name: "agent_mesh_client",
        title: "Agent Mesh Client",
        version: "0.1.0",
      },
      capabilities: null,
    });
    this.#notify("initialized", {});
  }

  #onLine(line: string): void {
    let message: RpcResponse | RpcRequest | RpcNotification;
    try {
      message = JSON.parse(line) as RpcResponse | RpcRequest | RpcNotification;
    } catch (error) {
      this.onDiagnostic?.("Codex app-server emitted malformed JSON", error);
      return;
    }
    if ("id" in message && !("method" in message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new RuntimeAdapterError(
            "RPC_ERROR",
            `Codex ${message.error.code ?? "error"}: ${message.error.message ?? "request failed"}`,
          ),
        );
      } else pending.resolve(message.result);
      return;
    }
    if ("id" in message && "method" in message) {
      this.#answerServerRequest(message);
      return;
    }
    if (!("method" in message)) return;
    if (message.method === "item/completed") {
      const params = message.params as
        | { threadId?: unknown; turnId?: unknown; item?: { type?: unknown; text?: unknown } }
        | undefined;
      if (
        this.#active &&
        params?.threadId === this.#active.threadId &&
        (!this.#active.turnId || params.turnId === this.#active.turnId) &&
        params.item?.type === "agentMessage" &&
        typeof params.item.text === "string"
      ) {
        this.#active.lastAgentMessage = params.item.text;
      }
      return;
    }
    if (message.method === "turn/completed") {
      const params = message.params as
        | {
            threadId?: unknown;
            turn?: {
              id?: unknown;
              status?: unknown;
              error?: unknown;
              items?: Array<{ type?: unknown; text?: unknown }>;
            };
          }
        | undefined;
      if (
        this.#active &&
        params?.threadId === this.#active.threadId &&
        (!this.#active.turnId || params.turn?.id === this.#active.turnId)
      ) {
        const finalFromTurn = params.turn?.items
          ?.filter(
            (item): item is { type: "agentMessage"; text: string } =>
              item.type === "agentMessage" && typeof item.text === "string",
          )
          .at(-1)?.text;
        this.#active.resolve({
          status: typeof params.turn?.status === "string" ? params.turn.status : "failed",
          response: finalFromTurn ?? this.#active.lastAgentMessage,
          error: params.turn?.error,
        });
      }
    }
  }

  #answerServerRequest(request: RpcRequest): void {
    switch (request.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        this.#write({ id: request.id, result: { decision: "decline" } });
        break;
      case "applyPatchApproval":
      case "execCommandApproval":
        this.#write({
          id: request.id,
          result: { decision: { denied: { rejection: "No interactive approver" } } },
        });
        break;
      default:
        this.#write({
          id: request.id,
          error: { code: -32601, message: "Unsupported unattended server request" },
        });
    }
  }

  async #request(method: string, params?: unknown): Promise<unknown> {
    const child = this.#child;
    if (!child || child.exitCode !== null) {
      throw new RuntimeAdapterError("PROCESS_EXITED", "Codex app-server is not running");
    }
    const id = this.#nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RuntimeAdapterError("RPC_TIMEOUT", `${method} timed out`));
      }, 30_000);
      this.#pending.set(id, { resolve, reject, timer });
    });
    this.#write({ id, method, ...(params === undefined ? {} : { params }) });
    return await result;
  }

  #notify(method: string, params?: unknown): void {
    this.#write({ method, ...(params === undefined ? {} : { params }) });
  }

  #write(message: unknown): void {
    const child = this.#child;
    if (!child || child.exitCode !== null) {
      throw new RuntimeAdapterError("PROCESS_EXITED", "Codex app-server is not writable");
    }
    if (this.#socket) {
      this.#socket.send(JSON.stringify(message));
      return;
    }
    if (!child.stdin.writable) {
      throw new RuntimeAdapterError("PROCESS_EXITED", "Codex app-server is not writable");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /**
   * The unix transport is a WebSocket at `/rpc`, not the NDJSON that stdio
   * carries. Connecting with raw JSON is closed without an error, so the
   * mistake reads as a broken server rather than a wrong protocol.
   */
  async #connectSocket(path: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const exists = await stat(path).then(() => true, () => false);
      if (exists) break;
      if (this.#child?.exitCode !== null && this.#child?.exitCode !== undefined) {
        throw new RuntimeAdapterError(
          "PROCESS_EXITED",
          `Codex app-server exited before binding ${path}${
            this.#stderr.trim() ? `: ${this.#stderr.trim().slice(-500)}` : ""
          }`,
        );
      }
      if (Date.now() > deadline) {
        throw new RuntimeAdapterError(
          "RUNTIME_NOT_READY",
          `Codex app-server did not bind ${path} within 15s`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.#socket = await connectWsUnix(path, "/rpc", {
      onMessage: (payload) => this.#onLine(payload),
      onClose: (reason) => {
        this.#socket = null;
        this.#failAll(new RuntimeAdapterError("PROCESS_EXITED", `Codex app-server: ${reason}`));
      },
    });
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    if (this.#active) {
      this.#active.resolve({ status: "failed", response: null, error });
    }
  }

  async #withAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal,
    onAbort: () => Promise<void>,
  ): Promise<T> {
    if (signal.aborted) {
      await onAbort();
      throw signal.reason instanceof Error
        ? signal.reason
        : new RuntimeAdapterError("CANCELLED", "Runtime turn cancelled");
    }
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const handler = () => {
      void onAbort().finally(() =>
        rejectAbort(
          signal.reason instanceof Error
            ? signal.reason
            : new RuntimeAdapterError("CANCELLED", "Runtime turn cancelled"),
        ),
      );
    };
    signal.addEventListener("abort", handler, { once: true });
    try {
      return await Promise.race([promise, aborted]);
    } finally {
      signal.removeEventListener("abort", handler);
    }
  }
}
