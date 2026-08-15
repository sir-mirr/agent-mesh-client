import { chmod, mkdir, open, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { LaneConfig } from "../config/types";
import { laneStorageName } from "../config/paths";

export interface ClaudeSupervisorOptions {
  lane: LaneConfig;
  stateDirectory: string;
  runtimeDirectory: string;
  configFile: string;
  secretDirectory: string;
}

export interface ClaudeSupervisorStatus {
  /**
   * `awaiting-input` is separate from `running` because the two look identical
   * from outside and need opposite responses. Claude Code stops for a keyboard
   * answer three times on a fresh workspace -- folder trust, the development
   * channel warning, and the first `reply` tool call -- and until someone
   * answers, the turn sits in RUNNING with the lane reporting `running`. That
   * is indistinguishable from a slow turn, so the wait reads as latency and
   * nobody goes to the session that is asking.
   */
  state: "stopped" | "running" | "awaiting-input" | "unavailable" | "failed";
  tmuxSession: string;
  command: string | null;
  lastError: string | null;
  /** The question on screen, when one is blocking. UI text, never a payload. */
  prompt: string | null;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  await chmod(path, 0o600);
}

function mcpCommand(options: ClaudeSupervisorOptions): {
  command: string;
  args: string[];
} {
  const isBun = /bun(?:\.exe)?$/.test(process.execPath);
  return {
    command: process.execPath,
    args: [
      ...(isBun ? [process.argv[1]!] : []),
      "runtime",
      "mcp",
      "--lane",
      options.lane.id,
      "--config",
      options.configFile,
      "--runtime-dir",
      options.runtimeDirectory,
      "--secret-dir",
      options.secretDirectory,
    ],
  };
}

export class ClaudeSupervisor {
  readonly tmuxSession: string;
  readonly mcpConfigPath: string;
  #status: ClaudeSupervisorStatus;

  constructor(readonly options: ClaudeSupervisorOptions) {
    const storage = laneStorageName(options.lane.id);
    this.tmuxSession = `mesh-${storage}`;
    this.mcpConfigPath = resolve(options.stateDirectory, "claude-mcp.json");
    this.#status = {
      state: "stopped",
      tmuxSession: this.tmuxSession,
      command: null,
      lastError: null,
      prompt: null,
    };
  }

  get status(): ClaudeSupervisorStatus {
    if (this.#status.state === "running" || this.#status.state === "awaiting-input") {
      if (!this.#hasSession()) {
        this.#status = { ...this.#status, state: "stopped", prompt: null };
      } else {
        const prompt = this.#blockingPrompt();
        this.#status = {
          ...this.#status,
          state: prompt ? "awaiting-input" : "running",
          prompt,
        };
      }
    }
    return { ...this.#status };
  }

  async start(): Promise<void> {
    if (this.options.lane.runtime.kind !== "claude") return;
    if (this.#hasSession()) {
      this.#status = { ...this.#status, state: "running", lastError: null };
      return;
    }
    const tmux = Bun.which("tmux");
    const claude = this.options.lane.runtime.command ?? Bun.which("claude");
    if (!tmux || !claude) {
      this.#status = {
        ...this.#status,
        state: "unavailable",
        command: claude ?? null,
        lastError: !tmux ? "tmux is not installed" : "Claude CLI is not installed",
      };
      return;
    }
    const mcp = mcpCommand(this.options);
    await atomicJson(this.mcpConfigPath, {
      mcpServers: {
        "agent-mesh": { type: "stdio", command: mcp.command, args: mcp.args },
      },
    });
    const args = [
      "new-session",
      "-d",
      "-s",
      this.tmuxSession,
      "-c",
      this.options.lane.runtime.workspace,
      claude,
      "--mcp-config",
      this.mcpConfigPath,
      "--strict-mcp-config",
      "--dangerously-load-development-channels",
      "server:agent-mesh",
      "--name",
      `Agent Mesh · ${this.options.lane.id}`,
    ];
    if (this.options.lane.runtime.model) {
      args.push("--model", this.options.lane.runtime.model);
    }
    if (this.options.lane.runtime.security.profile === "sandboxed") {
      args.push("--permission-mode", "plan");
    } else if (this.options.lane.runtime.security.profile === "workspace") {
      args.push("--permission-mode", "default");
    } else {
      if (!this.options.lane.runtime.security.acknowledged_risk) {
        throw new Error("unrestricted Claude runtime requires acknowledged_risk=true");
      }
      args.push("--dangerously-skip-permissions");
    }
    const result = Bun.spawnSync([tmux, ...args], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString("utf8").trim();
      this.#status = {
        ...this.#status,
        state: "failed",
        command: claude,
        lastError: detail || `tmux exited ${result.exitCode}`,
      };
      throw new Error(this.#status.lastError ?? "Failed to launch Claude in tmux");
    }
    this.#status = {
      state: "running",
      tmuxSession: this.tmuxSession,
      command: claude,
      lastError: null,
      prompt: null,
    };
  }

  async stop(): Promise<void> {
    const tmux = Bun.which("tmux");
    if (tmux && this.#hasSession()) {
      Bun.spawnSync([tmux, "kill-session", "-t", this.tmuxSession], {
        stdout: "ignore",
        stderr: "ignore",
      });
    }
    this.#status = { ...this.#status, state: "stopped" };
  }

  /**
   * The question a blocked session is showing, or null.
   *
   * Read from the pane rather than inferred from timing: the runtime gives no
   * signal over MCP while it waits, and "RUNNING for a while" is also what a
   * long turn looks like. The selection cursor is the reliable marker -- every
   * blocking prompt draws `❯ 1.` under its question, and a turn in progress
   * never does.
   */
  #blockingPrompt(): string | null {
    const tmux = Bun.which("tmux");
    if (!tmux) return null;
    const captured = Bun.spawnSync(
      [tmux, "capture-pane", "-p", "-t", this.tmuxSession],
      { stdout: "pipe", stderr: "ignore" },
    );
    if (captured.exitCode !== 0) return null;
    const lines = captured.stdout.toString("utf8").split("\n");
    const cursor = lines.findIndex((line) => /^\s*\u276f\s*\d+\.\s/.test(line));
    if (cursor === -1) return null;
    // Look upward for the question rather than taking the nearest line: the
    // one directly above the choices is often a link or a footnote ("Security
    // guide"), and what the operator needs is the sentence being asked.
    const candidates: string[] = [];
    for (let index = cursor - 1; index >= 0 && index >= cursor - 14; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      if (/^\d+\.\s/.test(line)) continue;
      if (/^[\u2500-\u257f\s]*$/.test(line)) continue;
      candidates.push(line);
    }
    const asked = candidates.find((line) => line.includes("?"));
    const longest = candidates.reduce<string | null>(
      (best, line) => (best === null || line.length > best.length ? line : best),
      null,
    );
    return (asked ?? longest ?? "waiting for a keyboard answer").slice(0, 160);
  }

  #hasSession(): boolean {
    const tmux = Bun.which("tmux");
    if (!tmux) return false;
    return (
      Bun.spawnSync([tmux, "has-session", "-t", this.tmuxSession], {
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode === 0
    );
  }
}
