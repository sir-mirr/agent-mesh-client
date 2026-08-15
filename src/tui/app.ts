import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { ConfigStore } from "../config/store";
import type { LaneConfig, RuntimeKind } from "../config/types";
import { probeHostDaemon, requestControl } from "../daemon/host-daemon";
import { probeHub, resolveHubEndpoints, type HubEndpoints } from "../hub/endpoints";
import { lookupAgentIdentity } from "../hub/provisioning";
import { SecretStore } from "../config/secrets";
import { installUserService } from "../service/user-service";
import { IDENTITY_RE } from "@agent-mesh/contracts";

export interface TuiOptions {
  configFile: string;
  stateDirectory: string;
  runtimeDirectory: string;
  secretDirectory: string;
}

type Reader = ReturnType<typeof createInterface>;

function clear(): void {
  process.stdout.write("\u001b[2J\u001b[H");
}

function heading(title: string): void {
  clear();
  process.stdout.write(`Agent Mesh · ${title}\n${"─".repeat(64)}\n\n`);
}

async function ask(reader: Reader, prompt: string, fallback?: string): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await reader.question(`${prompt}${suffix}: `)).trim();
  return answer || fallback || "";
}

async function askSecret(reader: Reader, prompt: string): Promise<string> {
  if (process.platform !== "win32") {
    Bun.spawnSync(["stty", "-echo"], { stdin: "inherit", stdout: "ignore", stderr: "ignore" });
  }
  try {
    return (await reader.question(`${prompt}: `)).trim();
  } finally {
    if (process.platform !== "win32") {
      Bun.spawnSync(["stty", "echo"], { stdin: "inherit", stdout: "ignore", stderr: "ignore" });
    }
    process.stdout.write("\n");
  }
}

function agentType(runtime: RuntimeKind): string {
  if (runtime === "claude") return "ai-claude";
  if (runtime === "codex") return "ai-codex";
  return "ai-cli-adapter";
}

export function deriveLaneId(
  identity: string,
  occupied: Iterable<string> = [],
): string {
  const base = identity
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const used = new Set(occupied);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

async function askAgentIdentity(
  reader: Reader,
  existing: readonly LaneConfig[],
  endpoints: HubEndpoints,
): Promise<string> {
  while (true) {
    const identity = await ask(reader, "Agent Identity");
    if (!identity) {
      process.stdout.write("Agent Identity is required.\n");
      continue;
    }
    if (!IDENTITY_RE.test(identity)) {
      process.stdout.write(
        "Use letters, digits, or hyphens; start with a letter or digit. Identity is case-sensitive.\n",
      );
      continue;
    }
    if (existing.some((lane) => lane.identity === identity)) {
      process.stdout.write("That Agent Identity is already assigned to a local lane.\n");
      continue;
    }
    process.stdout.write("Checking Agent Identity in Mesh…\n");
    const registered = await lookupAgentIdentity(endpoints, identity);
    if (registered) {
      const state = registered.deleted
        ? "soft-deleted and permanently reserved"
        : `already registered${registered.keyStatus ? `; key ${registered.keyStatus}` : ""}`;
      process.stdout.write(`That Agent Identity is ${state}. Choose another identity.\n`);
      continue;
    }
    process.stdout.write("✓ Agent Identity is available in Mesh.\n");
    return identity;
  }
}

async function createLane(
  reader: Reader,
  endpoints: HubEndpoints,
  existing: readonly LaneConfig[] = [],
): Promise<LaneConfig> {
  heading("Create lane");
  const identity = await askAgentIdentity(reader, existing, endpoints);
  const id = deriveLaneId(identity, existing.map((lane) => lane.id));
  process.stdout.write(`Local lane ID: ${id}\n`);
  const runtimeInput = await ask(
    reader,
    "Runtime (claude/codex/antigravity)",
    "claude",
  );
  const runtime: RuntimeKind =
    runtimeInput === "codex" || runtimeInput === "antigravity"
      ? runtimeInput
      : "claude";
  const workspace = resolve(await ask(reader, "Workspace", process.cwd()));
  const securityInput = await ask(
    reader,
    "Security profile (sandboxed/workspace/unrestricted)",
    "workspace",
  );
  const profile =
    securityInput === "sandboxed" || securityInput === "unrestricted"
      ? securityInput
      : "workspace";
  let acknowledgedRisk = false;
  if (profile === "unrestricted") {
    heading("Confirm unrestricted runtime");
    process.stdout.write(
      "This runtime may execute tools without permission prompts. The installer will not weaken this choice silently.\n\n",
    );
    acknowledgedRisk = (
      await ask(reader, "I understand the risk and want unrestricted mode (y/N)", "N")
    ).toLowerCase() === "y";
    if (!acknowledgedRisk) throw new Error("Unrestricted runtime was not acknowledged");
  }
  return {
    id,
    identity,
    agent_type: agentType(runtime),
    enabled: true,
    runtime: {
      kind: runtime,
      workspace,
      reply_mode: "auto",
      timeout_seconds: 1_800,
      security: { profile, acknowledged_risk: acknowledgedRisk },
    },
    channels: [],
  };
}

async function ensureOnboarding(reader: Reader, options: TuiOptions): Promise<void> {
  const store = new ConfigStore(options.configFile);
  const config = await store.load();
  let changed = false;
  if (!config.hub) {
    heading("Onboarding · Hub");
    const baseUrl = await ask(reader, "Hub URL", "http://127.0.0.1:3100");
    process.stdout.write("Testing Hub…\n");
    const probe = await probeHub(baseUrl);
    process.stdout.write(`✓ Hub reachable · ${probe.endpoints.rpcWebSocket}\n`);
    config.hub = { base_url: baseUrl };
    changed = true;
    await reader.question("Press Enter to continue");
  }
  if (config.lanes.length === 0) {
    if (!config.hub) throw new Error("Hub must be configured before creating a lane");
    const endpoints = resolveHubEndpoints(config.hub.base_url, config.hub);
    config.lanes.push(await createLane(reader, endpoints, config.lanes));
    changed = true;
  }
  if (changed) await store.save(config);
}

async function startDaemon(options: TuiOptions): Promise<void> {
  if (await probeHostDaemon(options.runtimeDirectory)) return;
  const isBun = /bun(?:\.exe)?$/.test(process.execPath);
  // Release users get an OS-managed, restartable daemon. Source checkouts stay
  // self-contained so development and TUI smoke tests never alter user service
  // registration on the host.
  if (!isBun) {
    await installUserService(options);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (await probeHostDaemon(options.runtimeDirectory)) return;
      await Bun.sleep(100);
    }
    throw new Error("User service did not become ready within 8 seconds");
  }
  const argv = isBun
    ? [process.execPath, process.argv[1]!, "daemon", "run"]
    : [process.execPath, "daemon", "run"];
  argv.push(
    "--config",
    options.configFile,
    "--state-dir",
    options.stateDirectory,
    "--runtime-dir",
    options.runtimeDirectory,
    "--secret-dir",
    options.secretDirectory,
  );
  const child = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  child.unref();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await probeHostDaemon(options.runtimeDirectory)) return;
    await Bun.sleep(100);
  }
  throw new Error("Daemon did not become ready within 8 seconds");
}

async function dashboard(reader: Reader, options: TuiOptions): Promise<void> {
  while (true) {
    const lanes = (await requestControl(options.runtimeDirectory, "lane.list", {})) as Array<{
      lane_id: string;
      runtime: string;
      hub: { state: string; keyStatus: string | null; lastError: string | null } | null;
      runtime_status: { state: string; tmuxSession?: string; lastError?: string | null };
      outbox: { pending: number; retry: number; deadLetter: number; warning: boolean };
      channels: Array<{
        id: string;
        provider: string;
        enabled: boolean;
        status: { state: string; lastError?: string | null };
      }>;
    }>;
    heading("Overview");
    process.stdout.write("Daemon  ● Running\n\nLanes\n");
    for (const lane of lanes) {
      const hub = lane.hub?.state ?? "not-configured";
      process.stdout.write(
        `  ${lane.lane_id.padEnd(18)} ${lane.runtime.padEnd(12)} Hub ${hub.padEnd(10)} Outbox ${lane.outbox.pending}/${lane.outbox.retry}/${lane.outbox.deadLetter}\n`,
      );
      process.stdout.write(
        `    Runtime ${lane.runtime_status.state} · Channels ${lane.channels.length ? lane.channels.map((item) => `${item.id}:${item.status.state}`).join(", ") : "none"}\n`,
      );
      if (lane.hub?.lastError) process.stdout.write(`    ! ${lane.hub.lastError}\n`);
      if (lane.runtime_status.lastError) {
        process.stdout.write(`    ! ${lane.runtime_status.lastError}\n`);
      }
    }
    process.stdout.write(
      "\n[r] Refresh  [a] Add lane  [l] Lanes  [m] Send  [i] Inbox/reply  [g] Agents\n[c] Channels  [t] Attach runtime  [h] Hub/keys  [q] Quit\n",
    );
    const action = (await reader.question("> ")).trim().toLowerCase();
    if (action === "q") return;
    if (action === "a") {
      const store = new ConfigStore(options.configFile);
      const config = await store.load();
      if (!config.hub) throw new Error("Hub must be configured before creating a lane");
      const endpoints = resolveHubEndpoints(config.hub.base_url, config.hub);
      config.lanes.push(await createLane(reader, endpoints, config.lanes));
      await store.save(config);
      await requestControl(options.runtimeDirectory, "config.reload", {});
    } else if (action === "l") {
      await lanesScreen(reader, options);
    } else if (action === "m") {
      const lane = await ask(reader, "From lane", lanes[0]?.lane_id);
      const to = await ask(reader, "To identity");
      const content = await ask(reader, "Message");
      const result = await requestControl(options.runtimeDirectory, "mesh.send", {
        lane_id: lane,
        to,
        content,
      });
      process.stdout.write(`\n✓ ${JSON.stringify(result)}\n`);
      await reader.question("Press Enter");
    } else if (action === "g") {
      const lane = await ask(reader, "Lane", lanes[0]?.lane_id);
      const result = await requestControl(options.runtimeDirectory, "mesh.list_agents", {
        lane_id: lane,
      });
      process.stdout.write(`\n${JSON.stringify(result, null, 2)}\n`);
      await reader.question("Press Enter");
    } else if (action === "h") {
      heading("Hub and identity keys");
      for (const lane of lanes) {
        process.stdout.write(
          `${lane.lane_id}\n  connection: ${lane.hub?.state ?? "not-configured"}\n  key status: ${lane.hub?.keyStatus ?? "unknown"}\n  fingerprint: ${(lane.hub as { fingerprint?: string } | null)?.fingerprint ?? "not-generated"}\n\n`,
        );
      }
      await reader.question("Press Enter");
    } else if (action === "t") {
      const lane = await ask(reader, "Lane", lanes[0]?.lane_id);
      const selected = lanes.find((item) => item.lane_id === lane);
      if (!selected?.runtime_status.tmuxSession) {
        process.stdout.write("This runtime has no tmux session.\n");
        await reader.question("Press Enter");
      } else {
        const tmux = Bun.which("tmux");
        if (!tmux) throw new Error("tmux is not installed");
        reader.pause();
        const child = Bun.spawn(
          [tmux, "attach-session", "-t", selected.runtime_status.tmuxSession],
          { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
        );
        await child.exited;
        reader.resume();
      }
    } else if (action === "c") {
      await channelsScreen(reader, options, lanes.map((lane) => lane.lane_id));
    } else if (action === "i") {
      const lane = await ask(reader, "Lane", lanes[0]?.lane_id);
      const turns = (await requestControl(options.runtimeDirectory, "mesh.inbox", {
        lane_id: lane,
      })) as Array<{
        turnId: string;
        sourceKind: string;
        sourceMessageId: string;
        content: string;
        correlation: { from?: unknown };
        state: string;
      }>;
      process.stdout.write("\nInbox\n");
      turns.forEach((turn, index) => {
        const from = typeof turn.correlation.from === "string" ? turn.correlation.from : "channel";
        process.stdout.write(
          `  ${index + 1}. [${turn.state}] ${from}: ${turn.content.replace(/\s+/g, " ").slice(0, 100)}\n`,
        );
      });
      const selection = await ask(reader, "Reply number (blank to return)");
      if (selection) {
        const turn = turns[Number(selection) - 1];
        const to = turn?.correlation.from;
        if (!turn || typeof to !== "string") {
          process.stdout.write("Selected item is not a mesh message.\n");
        } else {
          const content = await ask(reader, "Reply");
          const result = await requestControl(options.runtimeDirectory, "mesh.send", {
            lane_id: lane,
            to,
            content,
            reply_to: turn.sourceMessageId,
          });
          process.stdout.write(`✓ ${JSON.stringify(result)}\n`);
        }
        await reader.question("Press Enter");
      }
    }
  }
}

async function lanesScreen(reader: Reader, options: TuiOptions): Promise<void> {
  while (true) {
    const store = new ConfigStore(options.configFile);
    const config = await store.load();
    heading("Lanes");
    for (const lane of config.lanes) {
      process.stdout.write(
        `  ${lane.id.padEnd(20)} ${lane.runtime.kind.padEnd(12)} ${lane.enabled ? "enabled" : "disabled"}\n`,
      );
    }
    process.stdout.write("\n[e] Enable  [d] Disable  [r] Remove  [b] Back\n");
    const action = (await reader.question("> ")).trim().toLowerCase();
    if (action === "b" || !action) return;
    if (action !== "e" && action !== "d" && action !== "r") continue;
    const id = await ask(reader, "Lane ID");
    const index = config.lanes.findIndex((lane) => lane.id === id);
    if (index === -1) {
      process.stdout.write("Unknown lane.\n");
      await reader.question("Press Enter");
      continue;
    }
    if (action === "r") {
      const confirm = (
        await ask(reader, `Remove ${id} config? Existing state/outbox stays (y/N)`, "N")
      ).toLowerCase();
      if (confirm !== "y") continue;
      config.lanes.splice(index, 1);
    } else {
      config.lanes[index]!.enabled = action === "e";
    }
    await store.save(config);
    await requestControl(options.runtimeDirectory, "config.reload", {});
  }
}

async function channelsScreen(
  reader: Reader,
  options: TuiOptions,
  laneIds: string[],
): Promise<void> {
  const laneId = await ask(reader, "Lane", laneIds[0]);
  while (true) {
    const store = new ConfigStore(options.configFile);
    const config = await store.load();
    const lane = config.lanes.find((item) => item.id === laneId);
    if (!lane) throw new Error(`Unknown lane: ${laneId}`);
    heading(`Channels · ${laneId}`);
    if (!lane.channels.length) process.stdout.write("No channel drivers configured.\n");
    for (const channel of lane.channels) {
      process.stdout.write(
        `  ${channel.id.padEnd(24)} ${channel.provider.padEnd(12)} ${channel.enabled ? "enabled" : "disabled"}\n`,
      );
    }
    process.stdout.write("\n[a] Add Discord  [e] Enable  [d] Disable  [r] Remove  [b] Back\n");
    const action = (await reader.question("> ")).trim().toLowerCase();
    if (action === "b" || !action) return;
    if (action === "a") {
      const id = await ask(reader, "Driver instance ID", `discord-${laneId}`);
      const accountRef = await ask(reader, "Bot account reference", "discord-bot");
      const token = await askSecret(reader, "Discord bot token (hidden)");
      const allowed = (await ask(reader, "Allowed channel IDs (comma-separated, blank=all)"))
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const mentionOnly = (await ask(reader, "Require bot mention? (y/N)", "N")).toLowerCase() === "y";
      const secretRef = `channel-${id}.token`;
      await new SecretStore(options.secretDirectory).set(secretRef, token);
      lane.channels.push({
        id,
        provider: "discord",
        enabled: true,
        account_ref: accountRef,
        secret_ref: secretRef,
        options: {
          ...(allowed.length ? { allowed_channel_ids: allowed } : {}),
          mention_only: mentionOnly,
        },
      });
      await store.save(config);
      await requestControl(options.runtimeDirectory, "config.reload", {});
      continue;
    }
    const id = await ask(reader, "Driver instance ID");
    const index = lane.channels.findIndex((item) => item.id === id);
    if (index === -1) {
      process.stdout.write("Unknown channel driver.\n");
      await reader.question("Press Enter");
      continue;
    }
    if (action === "e" || action === "d") {
      lane.channels[index]!.enabled = action === "e";
    } else if (action === "r") {
      const [removed] = lane.channels.splice(index, 1);
      if (removed) {
        config.retired_channel_ids ??= [];
        if (!config.retired_channel_ids.includes(removed.id)) {
          config.retired_channel_ids.push(removed.id);
        }
      }
      const removeSecret = (
        await ask(reader, "Also delete the stored provider token? (y/N)", "N")
      ).toLowerCase();
      if (removeSecret === "y" && removed) {
        await new SecretStore(options.secretDirectory).remove(removed.secret_ref);
      }
    } else continue;
    await store.save(config);
    await requestControl(options.runtimeDirectory, "config.reload", {});
  }
}

export async function runTui(options: TuiOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("TUI requires an interactive terminal");
  }
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await ensureOnboarding(reader, options);
    heading("Starting");
    process.stdout.write("Starting host daemon…\n");
    await startDaemon(options);
    await dashboard(reader, options);
  } finally {
    reader.close();
    process.stdout.write("\u001b[0m\n");
  }
}
