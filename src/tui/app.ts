import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { resolve } from "node:path";
import { ConfigStore } from "../config/store";
import type {
  LaneConfig,
  RuntimeKind,
  RuntimeSecurityConfig,
} from "../config/types";
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

class BackNavigation extends Error {
  constructor() {
    super("Back");
    this.name = "BackNavigation";
  }
}

const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const CYAN = "\u001b[96m";
const GREEN = "\u001b[92m";
const YELLOW = "\u001b[93m";
const RED = "\u001b[91m";
const SELECTED = "\u001b[1;97;48;5;24m";
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function paint(code: string, value: string): string {
  if (process.env.NO_COLOR !== undefined) return value;
  return `${code}${value}${RESET}`;
}

function visibleLength(value: string): number {
  return value.replace(ANSI_RE, "").length;
}

function padVisible(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}

function clip(value: string, width: number): string {
  if (value.length <= width) return value;
  return width <= 1 ? value.slice(0, width) : `${value.slice(0, width - 1)}…`;
}

function frameWidth(): number {
  return Math.max(40, Math.min(100, (process.stdout.columns ?? 82) - 2));
}

function dashboardColumns(): number {
  return frameWidth() >= 64 ? 2 : 1;
}

function clear(): void {
  process.stdout.write("\u001b[2J\u001b[H");
}

function heading(title: string, subtitle?: string): void {
  clear();
  const width = frameWidth();
  process.stdout.write(
    `${paint(`${BOLD}${CYAN}`, "◆ AGENT MESH")} ${paint(DIM, `· ${title}`)}\n`,
  );
  if (subtitle) process.stdout.write(`${paint(DIM, subtitle)}\n`);
  process.stdout.write(`${paint(DIM, "─".repeat(width))}\n\n`);
}

function writePanel(title: string, lines: readonly string[]): void {
  const width = frameWidth();
  const innerWidth = width - 2;
  const topFill = "─".repeat(Math.max(1, width - title.length - 5));
  process.stdout.write(`${paint(CYAN, `╭─ ${title} ${topFill}╮`)}\n`);
  for (const line of lines) {
    process.stdout.write(
      `${paint(CYAN, "│")}${padVisible(` ${line}`, innerWidth)}${paint(CYAN, "│")}\n`,
    );
  }
  process.stdout.write(`${paint(CYAN, `╰${"─".repeat(width - 2)}╯`)}\n`);
}

async function question(
  reader: Reader,
  prompt: string,
  allowBack: boolean,
): Promise<string> {
  if (!allowBack) return await reader.question(prompt);
  const controller = new AbortController();
  const stdin = process.stdin;
  emitKeypressEvents(stdin);
  const onKeypress = (
    _input: string | undefined,
    key: { name?: string },
  ) => {
    // Escape only. Backspace used to go back on an empty line, which put the
    // exit one keystroke past deleting the last character someone typed.
    if (key.name === "escape") {
      controller.abort();
    }
  };
  stdin.on("keypress", onKeypress);
  try {
    return await reader.question(prompt, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      process.stdout.write("\n");
      throw new BackNavigation();
    }
    throw error;
  } finally {
    stdin.off("keypress", onKeypress);
  }
}

async function ask(
  reader: Reader,
  prompt: string,
  fallback?: string,
  allowBack = false,
): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await question(reader, `${prompt}${suffix}: `, allowBack)).trim();
  return answer || fallback || "";
}

interface HorizontalChoice<T extends string> {
  value: T;
  label: string;
}

export function moveSelection(index: number, count: number, delta: number): number {
  if (count <= 0) throw new Error("Selection requires at least one choice");
  return (index + delta + count) % count;
}

export type GridDirection = "up" | "down" | "left" | "right";

export function moveGridSelection(
  index: number,
  count: number,
  columns: number,
  direction: GridDirection,
): number {
  if (count <= 0 || columns <= 0) throw new Error("Grid requires choices and columns");
  if (direction === "left") return moveSelection(index, count, -1);
  if (direction === "right") return moveSelection(index, count, 1);
  if (direction === "up") {
    if (index - columns >= 0) return index - columns;
    let candidate = index;
    while (candidate + columns < count) candidate += columns;
    return candidate;
  }
  if (index + columns < count) return index + columns;
  return index % columns;
}

interface GridChoice<T extends string> {
  value: T;
  label: string;
  description: string;
  icon: string;
}

async function selectGrid<T extends string>(
  reader: Reader,
  choices: readonly GridChoice<T>[],
  initialIndex: number,
  columns: number,
  render: (selectedIndex: number) => void,
): Promise<{ value: T; index: number }> {
  if (!choices[initialIndex]) throw new Error("Grid has no initial choice");
  const stdin = process.stdin;
  if (!stdin.isTTY || !process.stdout.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Grid selection requires an interactive terminal");
  }

  reader.pause();
  const previousRawMode = stdin.isRaw;
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  let selected = initialIndex;

  return await new Promise<{ value: T; index: number }>((resolveChoice, reject) => {
    const cleanup = () => {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode(previousRawMode);
      reader.resume();
    };
    const onKeypress = (
      _input: string | undefined,
      key: { name?: string; ctrl?: boolean },
    ) => {
      if (key.name === "escape") {
        cleanup();
        process.stdout.write("\n");
        reject(new BackNavigation());
        return;
      }
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.stdout.write("\n");
        reject(new Error("Selection cancelled"));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        const choice = choices[selected]!;
        cleanup();
        resolveChoice({ value: choice.value, index: selected });
        return;
      }
      const direction =
        key.name === "up" || key.name === "down" ||
          key.name === "left" || key.name === "right"
          ? key.name
          : null;
      if (direction) {
        selected = moveGridSelection(selected, choices.length, columns, direction);
      } else if (key.name === "tab") {
        selected = moveGridSelection(selected, choices.length, columns, "right");
      } else return;
      render(selected);
    };
    stdin.on("keypress", onKeypress);
    render(selected);
  });
}

async function selectHorizontal<T extends string>(
  reader: Reader,
  prompt: string,
  choices: readonly HorizontalChoice<T>[],
  initialIndex = 0,
): Promise<T> {
  const initial = choices[initialIndex];
  if (!initial) throw new Error("Selection has no initial choice");
  const stdin = process.stdin;
  if (!stdin.isTTY || !process.stdout.isTTY || typeof stdin.setRawMode !== "function") {
    const answer = await ask(
      reader,
      `${prompt} (${choices.map((choice) => choice.label).join("/")})`,
      initial.label,
    );
    return choices.find((choice) => choice.label.toLowerCase() === answer.toLowerCase())?.value ??
      initial.value;
  }

  reader.pause();
  const previousRawMode = stdin.isRaw;
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  let selected = initialIndex;

  const render = () => {
    const rendered = choices.map((choice, index) =>
      index === selected
        ? `\u001b[7m[${choice.label}]\u001b[0m`
        : `[${choice.label}]`
    ).join(" ");
    process.stdout.write(`\r\u001b[2K${prompt}: ${rendered}`);
  };

  return await new Promise<T>((resolveChoice, reject) => {
    const cleanup = () => {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode(previousRawMode);
      reader.resume();
    };
    const onKeypress = (
      _input: string | undefined,
      key: { name?: string; ctrl?: boolean },
    ) => {
      if (key.name === "escape") {
        cleanup();
        process.stdout.write("\n");
        reject(new BackNavigation());
        return;
      }
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.stdout.write("\n");
        reject(new Error("Selection cancelled"));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        const choice = choices[selected]!;
        cleanup();
        process.stdout.write("\n");
        resolveChoice(choice.value);
        return;
      }
      if (key.name === "left") selected = moveSelection(selected, choices.length, -1);
      else if (key.name === "right" || key.name === "tab") {
        selected = moveSelection(selected, choices.length, 1);
      } else return;
      render();
    };
    stdin.on("keypress", onKeypress);
    render();
  });
}

async function askSecret(reader: Reader, prompt: string, allowBack = false): Promise<string> {
  if (process.platform !== "win32") {
    Bun.spawnSync(["stty", "-echo"], { stdin: "inherit", stdout: "ignore", stderr: "ignore" });
  }
  try {
    return (await question(reader, `${prompt}: `, allowBack)).trim();
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
    const identity = await ask(reader, "Agent Identity", undefined, true);
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
      process.stdout.write("That Agent Identity is already assigned to a local agent.\n");
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
  heading("Add agent");
  process.stdout.write(`${paint(DIM, "Esc  Back")}\n\n`);
  const identity = await askAgentIdentity(reader, existing, endpoints);
  const id = deriveLaneId(identity, existing.map((lane) => lane.id));
  const runtime = await selectHorizontal<RuntimeKind>(
    reader,
    "CLI Runtime",
    [
      { value: "claude", label: "Claude" },
      { value: "codex", label: "Codex" },
      { value: "antigravity", label: "AntiGravity" },
    ],
  );
  const workspace = resolve(await ask(reader, "Workspace", process.cwd(), true));
  const profile = await selectHorizontal<RuntimeSecurityConfig["profile"]>(
    reader,
    "Security Profile",
    [
      { value: "sandboxed", label: "Sandboxed" },
      { value: "workspace", label: "Workspace" },
      { value: "unrestricted", label: "Unrestricted" },
    ],
    1,
  );
  let acknowledgedRisk = false;
  if (profile === "unrestricted") {
    heading("Confirm unrestricted runtime");
    process.stdout.write(
      "This runtime may execute tools without permission prompts. The installer will not weaken this choice silently.\n\n",
    );
    acknowledgedRisk = (
      await ask(
        reader,
        "I understand the risk and want unrestricted mode (y/N)",
        "N",
        true,
      )
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

interface DashboardLane {
  lane_id: string;
  identity: string;
  enabled: boolean;
  runtime: string;
  hub: {
    state: string;
    keyStatus: string | null;
    fingerprint?: string;
    lastError: string | null;
  } | null;
  runtime_status: { state: string; tmuxSession?: string; lastError?: string | null };
  outbox: { pending: number; retry: number; deadLetter: number; warning: boolean };
  channels: Array<{
    id: string;
    provider: string;
    enabled: boolean;
    status: { state: string; lastError?: string | null };
  }>;
}

type AgentAction = "keys" | "channels" | "attach" | "replay" | "toggle" | "remove" | "back";

function stateColor(state: string): string {
  const normalized = state.toLowerCase();
  if (["connected", "running", "ready", "idle", "active", "approved"].includes(normalized)) {
    return GREEN;
  }
  if (["failed", "error", "conflict", "revoked", "dead-letter"].includes(normalized)) {
    return RED;
  }
  return YELLOW;
}

function actionCell<T extends string>(
  action: GridChoice<T>,
  selected: boolean,
  width: number,
  description: boolean,
): string {
  const content = description
    ? `    ${action.description}`
    : `${selected ? " ›" : "  "}  ${action.icon} ${action.label}`;
  const padded = padVisible(clip(content, width), width);
  if (selected) return paint(SELECTED, padded);
  return description ? paint(DIM, padded) : padded;
}

function overviewChoices(lanes: readonly DashboardLane[]): GridChoice<string>[] {
  return [
    ...lanes.map((agent) => ({
      value: `agent:${agent.lane_id}`,
      icon: "●",
      label: agent.identity,
      description: `${agent.runtime} runtime`,
    })),
    { value: "add", icon: "+", label: "Add Agent", description: "Register a new runtime" },
    { value: "refresh", icon: "↻", label: "Refresh", description: "Reload live status" },
    { value: "quit", icon: "×", label: "Quit", description: "Leave Agent Mesh" },
  ];
}

function selectableLine(content: string, selected: boolean): string {
  const padded = padVisible(clip(content, frameWidth() - 4), frameWidth() - 4);
  return selected ? paint(SELECTED, padded) : padded;
}

function renderDashboard(
  lanes: readonly DashboardLane[],
  daemon: Awaited<ReturnType<typeof probeHostDaemon>>,
  choices: readonly GridChoice<string>[],
  selectedIndex: number,
): void {
  const compact = (process.stdout.rows ?? 30) < 30;
  heading("Overview", "Local control plane · live status");
  const activeDrivers = daemon?.lanes.reduce((sum, lane) => sum + lane.active_drivers, 0) ?? 0;
  const daemonState = daemon
    ? `${paint(GREEN, "●")} ${paint(BOLD, "Daemon running")}`
    : `${paint(RED, "●")} ${paint(BOLD, "Daemon stopped")}`;
  writePanel("Host", [
    `${daemonState}   ${paint(DIM, `PID ${daemon?.pid ?? "—"}  ·  Agents ${lanes.length}  ·  Drivers ${activeDrivers}`)}`,
  ]);
  process.stdout.write("\n");

  const agentLines: string[] = [];
  if (!lanes.length) {
    agentLines.push(
      `${paint(YELLOW, "○")} No agents registered.`,
      paint(DIM, "  Select Add Agent to connect a runtime to the Mesh."),
    );
  } else {
    const terminalRows = process.stdout.rows ?? 30;
    const rowsPerAgent = compact ? 1 : 2;
    const maxVisible = Math.max(1, Math.floor((terminalRows - 17) / rowsPerAgent));
    const selectedAgentIndex = Math.min(selectedIndex, lanes.length - 1);
    let start = Math.max(0, selectedAgentIndex - maxVisible + 1);
    if (selectedIndex >= lanes.length) start = Math.max(0, lanes.length - maxVisible);
    const visibleAgents = lanes.slice(start, start + maxVisible);
    if (start > 0) agentLines.push(paint(DIM, `  ↑ ${start} more agents`));
    for (const [offset, agent] of visibleAgents.entries()) {
      const index = start + offset;
      const selected = index === selectedIndex;
      const hubState = agent.hub?.state ?? "not-configured";
      const runtimeState = agent.runtime_status.state;
      const outboxColor = agent.outbox.deadLetter > 0
        ? RED
        : agent.outbox.warning || agent.outbox.retry > 0
          ? YELLOW
          : GREEN;
      const plainSummary = `${selected ? "›" : " "} ● ${agent.identity}  ${agent.runtime.toUpperCase()}  · Hub ${hubState} · Runtime ${runtimeState}`;
      if (selected) {
        agentLines.push(selectableLine(plainSummary, true));
      } else {
        agentLines.push(
          `${paint(stateColor(runtimeState), "●")} ${paint(BOLD, clip(agent.identity, 24))}  ${paint(DIM, agent.runtime.toUpperCase())}  · Hub ${paint(stateColor(hubState), hubState)} · Runtime ${paint(stateColor(runtimeState), runtimeState)}`,
        );
      }
      if (!compact) {
        agentLines.push(
          `    Key ${agent.hub?.keyStatus ?? "unknown"} · Channels ${agent.channels.length} · Outbox ${paint(outboxColor, `${agent.outbox.pending}/${agent.outbox.retry}/${agent.outbox.deadLetter}`)}`,
        );
      }
    }
    const hiddenAfter = lanes.length - (start + visibleAgents.length);
    if (hiddenAfter > 0) {
      agentLines.push(paint(DIM, `  ↓ ${hiddenAfter} more agents`));
    }
  }
  if (agentLines.length) agentLines.push("");
  for (let index = lanes.length; index < choices.length; index += 1) {
    const choice = choices[index]!;
    agentLines.push(
      selectableLine(`${index === selectedIndex ? "›" : " "} ${choice.icon} ${choice.label}`, index === selectedIndex),
    );
  }
  writePanel(`Agents · ${lanes.length}`, agentLines);
  process.stdout.write(
    `\n${paint(DIM, "↑ ↓  Select    Enter  Open    Esc  Back    Ctrl+C  Exit")}\n`,
  );
}

function agentActions(agent: DashboardLane): readonly GridChoice<AgentAction>[] {
  return [
    { value: "keys", icon: "◆", label: "Identity Key", description: "Approval and fingerprint" },
    { value: "channels", icon: "#", label: "Channels", description: "Manage channel drivers" },
    { value: "attach", icon: "⌁", label: "Attach Runtime", description: "Open the CLI session" },
    // Only when there is something to replay. The status panel paints a
    // dead-letter count red, and an always-present action that usually does
    // nothing teaches the operator to ignore the one time it matters.
    ...(agent.outbox.deadLetter > 0
      ? ([
          {
            value: "replay",
            icon: "↺",
            label: "Replay Dead Letters",
            description: `Requeue ${agent.outbox.deadLetter} quarantined event(s)`,
          },
        ] as const)
      : []),
    {
      value: "toggle",
      icon: agent.enabled ? "○" : "●",
      label: agent.enabled ? "Disable Agent" : "Enable Agent",
      description: agent.enabled ? "Stop without deleting" : "Start this agent",
    },
    { value: "remove", icon: "−", label: "Remove Agent", description: "Keep durable state and outbox" },
    { value: "back", icon: "←", label: "Back", description: "Return to all agents" },
  ];
}

function renderAgentDetail(agent: DashboardLane, selectedIndex: number): void {
  heading(`Agent · ${agent.identity}`, `${agent.runtime.toUpperCase()} CLI runtime`);
  const hubState = agent.hub?.state ?? "not-configured";
  const runtimeState = agent.runtime_status.state;
  const statusLines = [
    `Status     ${paint(agent.enabled ? GREEN : YELLOW, agent.enabled ? "Enabled" : "Disabled")}`,
    `Hub        ${paint(stateColor(hubState), hubState)}`,
    `Key        ${paint(stateColor(agent.hub?.keyStatus ?? "unknown"), agent.hub?.keyStatus ?? "unknown")}`,
    `Runtime    ${paint(stateColor(runtimeState), runtimeState)}`,
    `Channels   ${agent.channels.length ? agent.channels.map((item) => `${item.id}:${item.status.state}`).join(", ") : "none"}`,
    // Spelled out here rather than the overview's three slashed numbers: this
    // is the screen where an operator decides whether to act on them.
    `Outbox     ${agent.outbox.pending} pending · ${agent.outbox.retry} retry · ${paint(
      agent.outbox.deadLetter > 0 ? RED : DIM,
      `${agent.outbox.deadLetter} dead-letter`,
    )}`,
  ];
  const error = agent.hub?.lastError ?? agent.runtime_status.lastError;
  if (error) statusLines.push(paint(RED, `! ${clip(error, frameWidth() - 6)}`));
  writePanel("Agent status", statusLines);
  process.stdout.write("\n");

  const actions = agentActions(agent);
  const columns = dashboardColumns();
  const compact = (process.stdout.rows ?? 30) < 30;
  const cellWidth = Math.floor((frameWidth() - 5) / columns);
  const actionLines: string[] = [];
  for (let index = 0; index < actions.length; index += columns) {
    const row = actions.slice(index, index + columns);
    actionLines.push(
      row.map((action, offset) => actionCell(action, index + offset === selectedIndex, cellWidth, false)).join("  "),
    );
    if (!compact) {
      actionLines.push(
        row.map((action, offset) => actionCell(action, index + offset === selectedIndex, cellWidth, true)).join("  "),
      );
      if (index + columns < actions.length) actionLines.push("");
    }
  }
  writePanel("Manage agent", actionLines);
  process.stdout.write(
    `\n${paint(DIM, "↑ ↓ ← →  Navigate    Enter  Select    Esc  Back")}\n`,
  );
}

async function attachAgentRuntime(reader: Reader, agent: DashboardLane): Promise<void> {
  if (!agent.runtime_status.tmuxSession) {
    process.stdout.write("This agent has no attachable runtime session.\n");
    try {
      await ask(reader, "Press Enter to go back", undefined, true);
    } catch (error) {
      if (!(error instanceof BackNavigation)) throw error;
    }
    return;
  }
  const tmux = Bun.which("tmux");
  if (!tmux) throw new Error("tmux is not available in the TUI environment");
  reader.pause();
  const child = Bun.spawn(
    [tmux, "attach-session", "-t", agent.runtime_status.tmuxSession],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  await child.exited;
  reader.resume();
}

async function agentDetail(
  reader: Reader,
  options: TuiOptions,
  initial: DashboardLane,
): Promise<void> {
  let selectedAction = 0;
  while (true) {
    const agents = await requestControl(
      options.runtimeDirectory,
      "lane.list",
      {},
    ) as DashboardLane[];
    const agent = agents.find((item) => item.lane_id === initial.lane_id);
    if (!agent) return;
    const actions = agentActions(agent);
    let selection: { value: AgentAction; index: number };
    try {
      selection = await selectGrid(
        reader,
        actions,
        Math.min(selectedAction, actions.length - 1),
        dashboardColumns(),
        (index) => renderAgentDetail(agent, index),
      );
    } catch (error) {
      if (error instanceof BackNavigation) return;
      throw error;
    }
    selectedAction = selection.index;
    if (selection.value === "back") return;
    if (selection.value === "keys") {
      heading(`Identity key · ${agent.identity}`);
      writePanel("Hub identity", [
        `Connection    ${agent.hub?.state ?? "not-configured"}`,
        `Key status    ${agent.hub?.keyStatus ?? "unknown"}`,
        `Fingerprint   ${agent.hub?.fingerprint ?? "not-generated"}`,
      ]);
      try {
        await ask(reader, "\nPress Enter to go back", undefined, true);
      } catch (error) {
        if (!(error instanceof BackNavigation)) throw error;
      }
    } else if (selection.value === "channels") {
      await channelsScreen(reader, options, agent.lane_id);
    } else if (selection.value === "attach") {
      await attachAgentRuntime(reader, agent);
    } else if (selection.value === "replay") {
      const result = (await requestControl(options.runtimeDirectory, "outbox.replay", {
        lane_id: agent.lane_id,
      })) as { replayed?: number; skipped?: number };
      heading(`Replay dead letters · ${agent.identity}`);
      writePanel("Outbox replay", [
        `Requeued   ${result.replayed ?? 0}`,
        `Skipped    ${result.skipped ?? 0}`,
        // Nothing here promises the append will succeed. A payload the Hub
        // refuses for its own content dead-letters again on the next attempt,
        // and its attempt count is the thing that says so.
        paint(DIM, "Requeued events keep their attempt count and last error."),
      ]);
      try {
        await ask(reader, "\nPress Enter to go back", undefined, true);
      } catch (error) {
        if (!(error instanceof BackNavigation)) throw error;
      }
    } else {
      const store = new ConfigStore(options.configFile);
      const config = await store.load();
      const index = config.lanes.findIndex((item) => item.id === agent.lane_id);
      if (index === -1) return;
      if (selection.value === "toggle") {
        config.lanes[index]!.enabled = !config.lanes[index]!.enabled;
      } else if (selection.value === "remove") {
        let confirm: string;
        try {
          confirm = (
            await ask(
              reader,
              `Remove agent ${agent.identity}? Durable state and outbox will remain (y/N)`,
              "N",
              true,
            )
          ).toLowerCase();
        } catch (error) {
          if (error instanceof BackNavigation) continue;
          throw error;
        }
        if (confirm !== "y") continue;
        config.lanes.splice(index, 1);
      }
      await store.save(config);
      await requestControl(options.runtimeDirectory, "config.reload", {});
      if (selection.value === "remove") return;
    }
  }
}

async function dashboard(reader: Reader, options: TuiOptions): Promise<void> {
  let selectedValue: string | undefined;
  while (true) {
    const [agents, daemon] = await Promise.all([
      requestControl(options.runtimeDirectory, "lane.list", {}) as Promise<DashboardLane[]>,
      probeHostDaemon(options.runtimeDirectory),
    ]);
    const choices = overviewChoices(agents);
    const selectedIndex = Math.max(0, choices.findIndex((item) => item.value === selectedValue));
    let selection: { value: string; index: number };
    try {
      selection = await selectGrid(
        reader,
        choices,
        selectedIndex,
        1,
        (index) => renderDashboard(agents, daemon, choices, index),
      );
    } catch (error) {
      if (error instanceof BackNavigation) return;
      throw error;
    }
    selectedValue = selection.value;
    if (selection.value === "quit") return;
    if (selection.value === "refresh") continue;
    if (selection.value === "add") {
      const store = new ConfigStore(options.configFile);
      const config = await store.load();
      if (!config.hub) throw new Error("Hub must be configured before adding an agent");
      const endpoints = resolveHubEndpoints(config.hub.base_url, config.hub);
      try {
        config.lanes.push(await createLane(reader, endpoints, config.lanes));
      } catch (error) {
        if (error instanceof BackNavigation) continue;
        throw error;
      }
      await store.save(config);
      await requestControl(options.runtimeDirectory, "config.reload", {});
      continue;
    }
    if (selection.value.startsWith("agent:")) {
      const id = selection.value.slice("agent:".length);
      const agent = agents.find((item) => item.lane_id === id);
      if (agent) await agentDetail(reader, options, agent);
    }
  }
}

async function channelsScreen(
  reader: Reader,
  options: TuiOptions,
  agentId: string,
): Promise<void> {
  type ChannelAction = "add" | "enable" | "disable" | "remove" | "back";
  const laneId = agentId;
  while (true) {
    const store = new ConfigStore(options.configFile);
    const config = await store.load();
    const lane = config.lanes.find((item) => item.id === laneId);
    if (!lane) throw new Error(`Unknown agent: ${laneId}`);
    heading(`Channels · ${lane.identity}`);
    if (!lane.channels.length) process.stdout.write("No channel drivers configured.\n");
    for (const channel of lane.channels) {
      process.stdout.write(
        `  ${channel.id.padEnd(24)} ${channel.provider.padEnd(12)} ${channel.enabled ? "enabled" : "disabled"}\n`,
      );
    }
    process.stdout.write(`\n${paint(DIM, "Esc  Back")}\n\n`);
    const actionChoices: HorizontalChoice<ChannelAction>[] = [
      { value: "add", label: "Add Discord" },
      ...(lane.channels.some((channel) => !channel.enabled)
        ? [{ value: "enable" as const, label: "Enable" }]
        : []),
      ...(lane.channels.some((channel) => channel.enabled)
        ? [{ value: "disable" as const, label: "Disable" }]
        : []),
      ...(lane.channels.length ? [{ value: "remove" as const, label: "Remove" }] : []),
      { value: "back", label: "Back" },
    ];
    let action: ChannelAction;
    try {
      action = await selectHorizontal(reader, "Channel Action", actionChoices);
    } catch (error) {
      if (error instanceof BackNavigation) return;
      throw error;
    }
    if (action === "back") return;
    if (action === "add") {
      let id: string;
      let accountRef: string;
      let token: string;
      let allowed: string[];
      let mentionOnly: boolean;
      try {
        id = await ask(reader, "Driver instance ID", `discord-${laneId}`, true);
        accountRef = await ask(reader, "Bot account reference", "discord-bot", true);
        token = await askSecret(reader, "Discord bot token (hidden)", true);
        allowed = (await ask(
          reader,
          "Allowed channel IDs (comma-separated, blank=all)",
          undefined,
          true,
        ))
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        mentionOnly = (
          await ask(reader, "Require bot mention? (y/N)", "N", true)
        ).toLowerCase() === "y";
      } catch (error) {
        if (error instanceof BackNavigation) continue;
        throw error;
      }
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
    const candidates = action === "enable"
      ? lane.channels.filter((channel) => !channel.enabled)
      : action === "disable"
        ? lane.channels.filter((channel) => channel.enabled)
        : lane.channels;
    let id: string;
    try {
      id = await selectHorizontal(
        reader,
        "Channel",
        candidates.map((channel) => ({ value: channel.id, label: channel.id })),
      );
    } catch (error) {
      if (error instanceof BackNavigation) continue;
      throw error;
    }
    const index = lane.channels.findIndex((item) => item.id === id);
    if (index === -1) throw new Error(`Selected channel disappeared: ${id}`);
    if (action === "enable" || action === "disable") {
      lane.channels[index]!.enabled = action === "enable";
    } else if (action === "remove") {
      const [removed] = lane.channels.splice(index, 1);
      if (removed) {
        config.retired_channel_ids ??= [];
        if (!config.retired_channel_ids.includes(removed.id)) {
          config.retired_channel_ids.push(removed.id);
        }
      }
      let removeSecret: string;
      try {
        removeSecret = (
          await ask(reader, "Also delete the stored provider token? (y/N)", "N", true)
        ).toLowerCase();
      } catch (error) {
        if (error instanceof BackNavigation) continue;
        throw error;
      }
      if (removeSecret === "y" && removed) {
        await new SecretStore(options.secretDirectory).remove(removed.secret_ref);
      }
    }
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
