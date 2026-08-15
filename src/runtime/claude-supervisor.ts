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
  state: "stopped" | "running" | "unavailable" | "failed";
  tmuxSession: string;
  command: string | null;
  lastError: string | null;
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
    };
  }

  get status(): ClaudeSupervisorStatus {
    if (this.#status.state === "running" && !this.#hasSession()) {
      this.#status = { ...this.#status, state: "stopped" };
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
