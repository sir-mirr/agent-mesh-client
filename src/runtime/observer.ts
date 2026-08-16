import { requestControl } from "../daemon/host-daemon";

/**
 * The redacted observer for runtimes that have no interactive session.
 *
 * Antigravity runs one `agy --print` child per turn and keeps nothing
 * resident, so there is no CLI to attach to the way there is for Claude or
 * Codex. What an operator needs to see is the queue: which turns arrived,
 * what state they are in, and which ones failed.
 *
 * It shows sizes, never bodies. Prompt text, model output, reasoning and auth
 * codes are the things that must not sit on a shared terminal, and the daemon
 * already withholds them -- `runtime.observe` returns character counts, so
 * this renderer has nothing to leak even if it tried.
 */

const RESET = "[0m";
const DIM = "[2m";
const BOLD = "[1m";
const CYAN = "[96m";
const GREEN = "[92m";
const YELLOW = "[93m";
const RED = "[91m";

interface ObservedTurn {
  turn_id: string;
  source_kind: string;
  from: string | null;
  state: string;
  prompt_chars: number;
  response_chars: number | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
}

interface Observation {
  lane_id: string;
  runtime: string;
  workspace: string;
  turns: ObservedTurn[];
}

function paint(code: string, value: string): string {
  return process.env.NO_COLOR === undefined ? `${code}${value}${RESET}` : value;
}

function stateColor(state: string): string {
  if (state === "COMPLETED" || state === "OBSERVED") return GREEN;
  if (state === "FAILED") return RED;
  if (state === "RUNNING") return CYAN;
  return YELLOW;
}

function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 19);
}

/** Seconds a turn has been in its current state, for spotting a stuck one. */
function age(turn: ObservedTurn, now: number): string {
  const seconds = Math.max(0, Math.round((now - turn.updated_at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

function render(observation: Observation, error: string | null): void {
  const now = Date.now();
  const lines: string[] = [];
  lines.push(
    `${paint(`${BOLD}${CYAN}`, "◆ AGENT MESH")} ${paint(DIM, `· observer · ${observation.lane_id}`)}`,
  );
  lines.push(
    paint(DIM, `${observation.runtime} runtime · ${observation.workspace} · ${clock(now)}`),
  );
  lines.push(paint(DIM, "─".repeat(76)));
  if (error) lines.push(paint(RED, `! ${error}`));
  if (observation.turns.length === 0) {
    lines.push(paint(DIM, "  대기 중인 turn이 없습니다. 이 runtime은 turn마다 child를 실행합니다."));
  } else {
    lines.push(
      paint(DIM, "  TIME      STATE       FROM            IN    OUT   AGE    TURN"),
    );
    for (const turn of observation.turns.slice(0, 20)) {
      const out = turn.response_chars === null ? "-" : String(turn.response_chars);
      const from = (turn.from ?? turn.source_kind).slice(0, 14).padEnd(14);
      const row =
        `  ${clock(turn.created_at)}  ` +
        `${paint(stateColor(turn.state), turn.state.padEnd(10))}  ` +
        `${from}  ${String(turn.prompt_chars).padStart(4)}  ${out.padStart(4)}  ` +
        `${age(turn, now).padStart(5)}  ${paint(DIM, turn.turn_id.slice(5, 17))}`;
      lines.push(row);
      if (turn.error_code) lines.push(paint(RED, `            ${turn.error_code}`));
    }
  }
  lines.push("");
  lines.push(paint(DIM, "  본문은 표시하지 않습니다 — IN/OUT은 글자 수입니다. Ctrl+C로 종료."));
  process.stdout.write(`[2J[H${lines.join("\n")}\n`);
}

export async function runRuntimeObserver(options: {
  laneId: string;
  runtimeDirectory: string;
  intervalMs?: number;
}): Promise<void> {
  const interval = options.intervalMs ?? 1_000;
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let last: Observation = {
    lane_id: options.laneId,
    runtime: "unknown",
    workspace: "",
    turns: [],
  };
  while (!stopped) {
    let error: string | null = null;
    try {
      last = (await requestControl(options.runtimeDirectory, "runtime.observe", {
        lane_id: options.laneId,
      })) as Observation;
    } catch (cause) {
      // A daemon restart is a normal event to watch through, not a reason to
      // drop the screen: keep the last view and say it is stale.
      error = cause instanceof Error ? cause.message : String(cause);
    }
    render(last, error);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
