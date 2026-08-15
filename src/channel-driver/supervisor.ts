import { resolve } from "node:path";
import type { ChannelConfig, LaneConfig } from "../config/types";
import { laneStorageName } from "../config/paths";

export interface ChannelProcessStatus {
  state: "starting" | "running" | "stopped" | "failed" | "unsupported";
  provider: string;
  pid: number | null;
  lastError: string | null;
}

export class ChannelProcessSupervisor {
  #child: ReturnType<typeof Bun.spawn> | null = null;
  #status: ChannelProcessStatus;
  #stopping = false;
  #restartAttempt = 0;
  #nextStartAt = 0;
  #startedAt = 0;

  constructor(
    readonly lane: LaneConfig,
    readonly channel: ChannelConfig,
    readonly options: {
      configFile: string;
      stateRoot: string;
      runtimeDirectory: string;
      secretDirectory: string;
    },
  ) {
    this.#status = {
      state: "stopped",
      provider: channel.provider,
      pid: null,
      lastError: null,
    };
  }

  get stateDirectory(): string {
    return resolve(
      this.options.stateRoot,
      "lanes",
      laneStorageName(this.lane.id),
      "channels",
      laneStorageName(this.channel.id),
    );
  }

  get status(): ChannelProcessStatus {
    if (this.#child && this.#child.exitCode !== null) {
      this.#status = {
        ...this.#status,
        state: this.#child.exitCode === 0 ? "stopped" : "failed",
        pid: null,
        lastError:
          this.#child.exitCode === 0
            ? null
            : `Driver exited with status ${this.#child.exitCode}`,
      };
      this.#child = null;
    }
    return { ...this.#status };
  }

  start(now = Date.now()): void {
    if (!this.channel.enabled || this.#child || this.#stopping || now < this.#nextStartAt) {
      return;
    }
    if (this.channel.provider !== "discord") {
      this.#status = {
        ...this.#status,
        state: "unsupported",
        lastError: `No provider implementation for ${this.channel.provider}`,
      };
      return;
    }
    const isBun = /bun(?:\.exe)?$/.test(process.execPath);
    const argv = [
      process.execPath,
      ...(isBun ? [process.argv[1]!] : []),
      "channel",
      "discord",
      "run",
      "--lane",
      this.lane.id,
      "--channel",
      this.channel.id,
      "--config",
      this.options.configFile,
      "--state-dir",
      this.stateDirectory,
      "--runtime-dir",
      this.options.runtimeDirectory,
      "--secret-dir",
      this.options.secretDirectory,
    ];
    this.#status = { ...this.#status, state: "starting", lastError: null };
    const child = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    });
    this.#child = child;
    this.#startedAt = now;
    this.#status = {
      ...this.#status,
      state: "running",
      pid: child.pid,
      lastError: null,
    };
    void child.exited.then((code) => {
      if (this.#child !== child) return;
      this.#child = null;
      if (this.#stopping) return;
      const stable = Date.now() - this.#startedAt >= 30_000;
      this.#restartAttempt = stable ? 0 : this.#restartAttempt + 1;
      const delay = Math.min(
        30_000,
        1_000 * 2 ** Math.min(this.#restartAttempt - 1, 5),
      );
      this.#nextStartAt = Date.now() + delay;
      this.#status = {
        ...this.#status,
        state: "failed",
        pid: null,
        lastError: `Driver exited with status ${code}; restart in ${delay}ms`,
      };
    });
  }

  maintain(now = Date.now()): void {
    void this.status;
    if (!this.#child && !this.#stopping && this.channel.enabled && now >= this.#nextStartAt) {
      this.start(now);
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const child = this.#child;
    this.#child = null;
    if (!child || child.exitCode !== null) {
      this.#status = { ...this.#status, state: "stopped", pid: null };
      return;
    }
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(5_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    this.#status = { ...this.#status, state: "stopped", pid: null };
  }
}
