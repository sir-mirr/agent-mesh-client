#!/usr/bin/env bun
import { basename, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { defaultLocations } from "./config/locations";
import { laneSocketPath, laneStorageName } from "./config/paths";
import { ConfigStore } from "./config/store";
import type { LaneConfig, RuntimeKind } from "./config/types";
import { AgentMeshDaemon } from "./daemon/agent-mesh-daemon";
import {
  HostDaemon,
  probeHostDaemon,
  requestControl,
} from "./daemon/host-daemon";
import { runTui } from "./tui/app";
import { runClaudeChannelMcp } from "./runtime/claude-channel-mcp";
import { runDiscordDriver } from "./channel-driver/discord";
import { resolveHubEndpoints } from "./hub/endpoints";
import { lookupAgentIdentity } from "./hub/provisioning";
import { SecretStore } from "./config/secrets";
import {
  installUserService,
  restartUserService,
  stopUserService,
  uninstallUserService,
  userServiceLogs,
  userServiceStatus,
} from "./service/user-service";

const VERSION = "0.1.0-dev.0";

const HELP = `agent-mesh ${VERSION}

Usage:
  agent-mesh                         Open onboarding or operations TUI
  agent-mesh daemon run|status|reload|stop
  agent-mesh config hub set URL|show
  agent-mesh lane add ID --runtime KIND --workspace PATH [--security-profile PROFILE]
  agent-mesh lane list|enable|disable|remove [ID]
  agent-mesh mesh send --lane ID --to ID --content TEXT
  agent-mesh mesh agents --lane ID
  agent-mesh mesh inbox --lane ID
  agent-mesh outbox status --lane ID
  agent-mesh runtime mcp --lane ID
  agent-mesh attach LANE_ID
  agent-mesh channel add ID --lane ID --provider discord --token-file PATH
  agent-mesh channel list|enable|disable|remove [ID] --lane ID
  agent-mesh service install|status|restart|stop|logs|uninstall
  agent-mesh up|down|restart|status|logs
  agent-mesh doctor
  agent-mesh paths lane-socket LANE_ID

Global paths may be overridden with --config, --state-dir and --runtime-dir.
`;

interface ParsedOptions {
  positionals: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
  configFile: string;
  stateDirectory: string;
  runtimeDirectory: string;
  secretDirectory: string;
}

const VALUE_OPTIONS = new Set([
  "--config",
  "--state-dir",
  "--runtime-dir",
  "--secret-dir",
  "--lane",
  "--runtime",
  "--workspace",
  "--identity",
  "--agent-type",
  "--security-profile",
  "--model",
  "--to",
  "--content",
  "--reply-to",
  "--client-message-id",
  "--channel",
  "--provider",
  "--token-file",
  "--account-ref",
]);
const BOOLEAN_OPTIONS = new Set(["--json", "--yes", "--acknowledge-risk"]);

function parseOptions(args: readonly string[]): ParsedOptions {
  const locations = defaultLocations();
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (VALUE_OPTIONS.has(arg)) {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      const existing = values.get(arg) ?? [];
      existing.push(value);
      values.set(arg, existing);
      index += 1;
    } else if (BOOLEAN_OPTIONS.has(arg)) {
      flags.add(arg);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  return {
    positionals,
    values,
    flags,
    configFile: values.get("--config")?.at(-1) ?? locations.configFile,
    stateDirectory:
      values.get("--state-dir")?.at(-1) ?? locations.stateDirectory,
    runtimeDirectory:
      values.get("--runtime-dir")?.at(-1) ?? locations.runtimeDirectory,
    secretDirectory:
      values.get("--secret-dir")?.at(-1) ?? locations.secretDirectory,
  };
}

function option(options: ParsedOptions, name: string): string | undefined {
  return options.values.get(name)?.at(-1);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runDaemon(options: ParsedOptions): Promise<void> {
  const manualLanes = options.values.get("--lane") ?? [];
  const diagnostic = (message: string, error?: unknown) => {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    process.stderr.write(`[agent-meshd] ${message}${detail}\n`);
  };
  const daemon =
    manualLanes.length > 0
      ? new HostDaemon({
          runtimeDirectory: options.runtimeDirectory,
          onDiagnostic: diagnostic,
        })
      : new AgentMeshDaemon({
          configFile: options.configFile,
          stateDirectory: options.stateDirectory,
          runtimeDirectory: options.runtimeDirectory,
          secretDirectory: options.secretDirectory,
          onDiagnostic: diagnostic,
        });
  if (daemon instanceof HostDaemon) await daemon.start(manualLanes);
  else await daemon.start();
  print(daemon instanceof HostDaemon ? daemon.status : daemon.host.status);

  await new Promise<void>((resolveStop) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void daemon
        .stop()
        .catch((error: unknown) => {
          process.stderr.write(
            `[agent-meshd] shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exitCode = 1;
        })
        .finally(resolveStop);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function reloadIfRunning(options: ParsedOptions): Promise<void> {
  const status = await probeHostDaemon(options.runtimeDirectory);
  if (status) await requestControl(options.runtimeDirectory, "config.reload", {});
}

function runtimeKind(options: ParsedOptions): RuntimeKind {
  const value = option(options, "--runtime") ?? "claude";
  if (value !== "claude" && value !== "codex" && value !== "antigravity") {
    throw new Error("--runtime must be claude, codex or antigravity");
  }
  return value;
}

function defaultAgentType(runtime: RuntimeKind): string {
  if (runtime === "claude") return "ai-claude";
  if (runtime === "codex") return "ai-codex";
  return "ai-cli-adapter";
}

async function mutateConfig(
  options: ParsedOptions,
  mutation: (config: Awaited<ReturnType<ConfigStore["load"]>>) => void,
): Promise<unknown> {
  const store = new ConfigStore(options.configFile);
  const config = await store.load();
  mutation(config);
  const saved = await store.save(config);
  await reloadIfRunning(options);
  return saved;
}

async function handleCommand(options: ParsedOptions): Promise<number | null> {
  const [group, command, value, ...extra] = options.positionals;
  if (group === "up" && !command) {
    print(await installUserService(options));
    return 0;
  }
  if (group === "down" && !command) {
    print(await stopUserService());
    return 0;
  }
  if (group === "restart" && !command) {
    print(await restartUserService(options));
    return 0;
  }
  if (group === "logs" && !command) {
    print(await userServiceLogs(options));
    return 0;
  }
  if (group === "service" && command === "install" && !value) {
    print(await installUserService(options));
    return 0;
  }
  if (group === "service" && command === "status" && !value) {
    print(await userServiceStatus());
    return 0;
  }
  if (group === "service" && command === "uninstall" && !value) {
    print(await uninstallUserService());
    return 0;
  }
  if (group === "service" && command === "restart" && !value) {
    print(await restartUserService(options));
    return 0;
  }
  if (group === "service" && command === "stop" && !value) {
    print(await stopUserService());
    return 0;
  }
  if (group === "service" && command === "logs" && !value) {
    print(await userServiceLogs(options));
    return 0;
  }
  if (group === "channel" && command === "discord" && value === "run") {
    const laneId = option(options, "--lane");
    const channelId = option(options, "--channel");
    if (!laneId || !channelId) throw new Error("channel discord run requires lane and channel");
    const config = await new ConfigStore(options.configFile).load();
    const lane = config.lanes.find((item) => item.id === laneId);
    const channel = lane?.channels.find((item) => item.id === channelId);
    if (!lane || !channel || channel.provider !== "discord") {
      throw new Error("Discord channel configuration was not found");
    }
    await runDiscordDriver({
      lane,
      channel,
      secretDirectory: options.secretDirectory,
      stateDirectory: options.stateDirectory,
      runtimeDirectory: options.runtimeDirectory,
    });
    return 0;
  }
  if (group === "attach" && command && !value) {
    const tmux = Bun.which("tmux");
    if (!tmux) throw new Error("tmux is not installed");
    const session = `mesh-${laneStorageName(command)}`;
    const child = Bun.spawn([tmux, "attach-session", "-t", session], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return await child.exited;
  }
  if (group === "runtime" && command === "mcp") {
    const laneId = option(options, "--lane");
    if (!laneId) throw new Error("runtime mcp requires --lane");
    await runClaudeChannelMcp({
      laneId,
      runtimeDirectory: options.runtimeDirectory,
    });
    return 0;
  }
  if (group === "daemon" && command === "run" && !value) {
    await runDaemon(options);
    return 0;
  }
  if ((group === "daemon" && command === "status") || group === "status") {
    const status = await probeHostDaemon(options.runtimeDirectory);
    print(status ?? { running: false });
    return status ? 0 : 1;
  }
  if (group === "daemon" && command === "reload") {
    print(await requestControl(options.runtimeDirectory, "config.reload", {}));
    return 0;
  }
  if (group === "daemon" && command === "stop") {
    print(await requestControl(options.runtimeDirectory, "daemon.shutdown", {}));
    return 0;
  }
  if (group === "config" && command === "hub" && value === "set") {
    const url = extra[0];
    if (!url) throw new Error("config hub set requires URL");
    new URL(url);
    print(
      await mutateConfig(options, (config) => {
        config.hub = { base_url: url };
      }),
    );
    return 0;
  }
  if (group === "config" && command === "hub" && value === "show") {
    print((await new ConfigStore(options.configFile).load()).hub);
    return 0;
  }
  if (group === "lane" && command === "add" && value) {
    const kind = runtimeKind(options);
    const workspace = resolve(option(options, "--workspace") ?? process.cwd());
    const securityProfile = option(options, "--security-profile") ?? "workspace";
    if (
      securityProfile !== "sandboxed" &&
      securityProfile !== "workspace" &&
      securityProfile !== "unrestricted"
    ) {
      throw new Error("--security-profile must be sandboxed, workspace or unrestricted");
    }
    if (securityProfile === "unrestricted" && !options.flags.has("--acknowledge-risk")) {
      throw new Error("unrestricted mode requires --acknowledge-risk");
    }
    const model = option(options, "--model");
    const identity = option(options, "--identity") ?? value;
    const current = await new ConfigStore(options.configFile).load();
    if (!current.hub) {
      throw new Error("Configure a Hub before adding a lane so Agent Identity can be checked");
    }
    if (current.lanes.some((item) => item.identity === identity)) {
      throw new Error(`Agent Identity is already assigned locally: ${identity}`);
    }
    const registered = await lookupAgentIdentity(
      resolveHubEndpoints(current.hub.base_url, current.hub),
      identity,
    );
    if (registered) {
      throw new Error(
        `Agent Identity already exists in Mesh: ${identity} (${registered.deleted ? "soft-deleted" : registered.keyStatus ?? "registered"})`,
      );
    }
    const lane: LaneConfig = {
      id: value,
      identity,
      agent_type: option(options, "--agent-type") ?? defaultAgentType(kind),
      enabled: true,
      runtime: {
        kind,
        ...(model ? { model } : {}),
        workspace,
        reply_mode: "auto",
        timeout_seconds: kind === "antigravity" ? 1_800 : 1_800,
        security: {
          profile: securityProfile,
          acknowledged_risk: options.flags.has("--acknowledge-risk"),
        },
      },
      channels: [],
    };
    print(
      await mutateConfig(options, (config) => {
        if (config.lanes.some((item) => item.id === value)) {
          throw new Error(`Lane already exists: ${value}`);
        }
        config.lanes.push(lane);
      }),
    );
    return 0;
  }
  if (group === "lane" && command === "list") {
    print((await new ConfigStore(options.configFile).load()).lanes);
    return 0;
  }
  if (group === "channel" && command === "add" && value) {
    const laneId = option(options, "--lane");
    const provider = option(options, "--provider") ?? "discord";
    const tokenFile = option(options, "--token-file");
    if (!laneId) throw new Error("channel add requires --lane");
    if (provider !== "discord") throw new Error("v0.1 only implements discord");
    if (!tokenFile) throw new Error("Discord channel add requires --token-file");
    const secretRef = `channel-${value}.token`;
    await new SecretStore(options.secretDirectory).set(
      secretRef,
      (await readFile(resolve(tokenFile), "utf8")).trim(),
    );
    print(
      await mutateConfig(options, (config) => {
        const lane = config.lanes.find((item) => item.id === laneId);
        if (!lane) throw new Error(`Unknown lane: ${laneId}`);
        if (
          config.lanes.some((item) => item.channels.some((ch) => ch.id === value)) ||
          config.retired_channel_ids?.includes(value)
        ) {
          throw new Error(`Channel driver ID already exists: ${value}`);
        }
        lane.channels.push({
          id: value,
          provider,
          enabled: true,
          account_ref: option(options, "--account-ref") ?? "discord-bot",
          secret_ref: secretRef,
          options: {},
        });
      }),
    );
    return 0;
  }
  if (group === "channel" && command === "list") {
    const laneId = option(options, "--lane");
    if (!laneId) throw new Error("channel list requires --lane");
    const lane = (await new ConfigStore(options.configFile).load()).lanes.find(
      (item) => item.id === laneId,
    );
    if (!lane) throw new Error(`Unknown lane: ${laneId}`);
    print(lane.channels);
    return 0;
  }
  if (
    group === "channel" &&
    (command === "enable" || command === "disable" || command === "remove") &&
    value
  ) {
    const laneId = option(options, "--lane");
    if (!laneId) throw new Error(`channel ${command} requires --lane`);
    print(
      await mutateConfig(options, (config) => {
        const lane = config.lanes.find((item) => item.id === laneId);
        if (!lane) throw new Error(`Unknown lane: ${laneId}`);
        const index = lane.channels.findIndex((item) => item.id === value);
        if (index === -1) throw new Error(`Unknown channel: ${value}`);
        if (command === "remove") {
          const [removed] = lane.channels.splice(index, 1);
          if (removed) {
            config.retired_channel_ids ??= [];
            if (!config.retired_channel_ids.includes(removed.id)) {
              config.retired_channel_ids.push(removed.id);
            }
          }
        }
        else lane.channels[index]!.enabled = command === "enable";
      }),
    );
    return 0;
  }
  if (
    group === "lane" &&
    (command === "enable" || command === "disable" || command === "remove") &&
    value
  ) {
    print(
      await mutateConfig(options, (config) => {
        const index = config.lanes.findIndex((lane) => lane.id === value);
        if (index === -1) throw new Error(`Unknown lane: ${value}`);
        if (command === "remove") config.lanes.splice(index, 1);
        else config.lanes[index]!.enabled = command === "enable";
      }),
    );
    return 0;
  }
  if (group === "mesh" && command === "send") {
    const laneId = option(options, "--lane");
    const to = option(options, "--to");
    const content = option(options, "--content");
    if (!laneId || !to || content === undefined) {
      throw new Error("mesh send requires --lane, --to and --content");
    }
    print(
      await requestControl(options.runtimeDirectory, "mesh.send", {
        lane_id: laneId,
        to,
        content,
        ...(option(options, "--reply-to")
          ? { reply_to: option(options, "--reply-to") }
          : {}),
        ...(option(options, "--client-message-id")
          ? { client_message_id: option(options, "--client-message-id") }
          : {}),
      }),
    );
    return 0;
  }
  if (group === "mesh" && command === "agents") {
    const laneId = option(options, "--lane");
    if (!laneId) throw new Error("mesh agents requires --lane");
    print(
      await requestControl(options.runtimeDirectory, "mesh.list_agents", {
        lane_id: laneId,
      }),
    );
    return 0;
  }
  if (group === "mesh" && command === "inbox") {
    const laneId = option(options, "--lane");
    if (!laneId) throw new Error("mesh inbox requires --lane");
    print(
      await requestControl(options.runtimeDirectory, "mesh.inbox", {
        lane_id: laneId,
      }),
    );
    return 0;
  }
  if (group === "outbox" && command === "status") {
    const laneId = option(options, "--lane");
    if (!laneId) throw new Error("outbox status requires --lane");
    print(
      await requestControl(options.runtimeDirectory, "outbox.summary", {
        lane_id: laneId,
      }),
    );
    return 0;
  }
  if (group === "doctor") {
    const config = await new ConfigStore(options.configFile).load();
    print({
      ok: true,
      config_file: options.configFile,
      config_revision: config.revision,
      daemon: (await probeHostDaemon(options.runtimeDirectory)) ?? { running: false },
      dependencies: {
        tmux: Bun.which("tmux") ?? null,
        claude: Bun.which("claude") ?? null,
        codex: Bun.which("codex") ?? null,
        antigravity: Bun.which("agy") ?? null,
      },
    });
    return 0;
  }
  if (group === "paths" && command === "lane-socket" && value && !extra.length) {
    process.stdout.write(`${laneSocketPath(options.runtimeDirectory, value)}\n`);
    return 0;
  }
  if (group === "tui") {
    await runTui(options);
    return 0;
  }
  return null;
}

export async function main(argv = process.argv): Promise<number> {
  const executable = basename(argv[1] ?? "agent-mesh");
  const rawArgs = argv.slice(2);
  if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const args = executable === "agent-meshd" ? ["daemon", "run", ...rawArgs] : rawArgs;
  const options = parseOptions(args);
  if (args.length === 0) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write(HELP);
      return 2;
    }
    await runTui(options);
    return 0;
  }
  const result = await handleCommand(options);
  if (result !== null) return result;
  process.stderr.write(HELP);
  return 2;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(
      `agent-mesh: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
