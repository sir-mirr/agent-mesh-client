import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const MAX_UNIX_SOCKET_PATH_BYTES = 100;

export function defaultRuntimeDirectory(env = process.env): string {
  const xdgRuntimeDirectory = env.XDG_RUNTIME_DIR;
  if (xdgRuntimeDirectory) {
    return join(xdgRuntimeDirectory, "agent-mesh");
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Caches", "agent-mesh", "runtime");
  }
  return join(homedir(), ".local", "state", "agent-mesh", "runtime");
}

export async function ensurePrivateRuntimeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export function laneSocketName(laneId: string): string {
  if (laneId.length === 0) throw new Error("lane ID must not be empty");
  const digest = createHash("sha256").update(laneId, "utf8").digest("hex");
  return `lane-${digest.slice(0, 24)}.sock`;
}

/**
 * The tmux session for a lane, named after the agent rather than a digest of
 * its id. `tmux ls` is where someone looks to see which window belongs to
 * which agent, and `mesh-lane-8ba3424e55e1` does not answer that. Identities
 * are `[A-Za-z0-9-]` and unique per host, so the readable name is also the
 * unambiguous one.
 */
export function laneTmuxSession(identity: string): string {
  if (identity.length === 0) throw new Error("Agent Identity must not be empty");
  return `mesh-lane-${identity}`;
}

export function laneStorageName(laneId: string): string {
  if (laneId.length === 0) throw new Error("lane ID must not be empty");
  const digest = createHash("sha256").update(laneId, "utf8").digest("hex");
  return `lane-${digest.slice(0, 24)}`;
}

function validateSocketPath(path: string): string {
  if (Buffer.byteLength(path, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(`Unix socket path is too long: ${path}`);
  }
  return path;
}

export function laneSocketPath(runtimeDirectory: string, laneId: string): string {
  return validateSocketPath(join(runtimeDirectory, laneSocketName(laneId)));
}

/**
 * Where the Codex app-server for a lane listens.
 *
 * Separate from the lane's own channel socket because a different program
 * owns it: `codex app-server --listen unix://PATH` creates this one, and the
 * `codex --remote` TUI connects to the same path so an operator can watch the
 * session the daemon is driving.
 */
export function appServerSocketPath(runtimeDirectory: string, laneId: string): string {
  if (laneId.length === 0) throw new Error("lane ID must not be empty");
  const digest = createHash("sha256").update(laneId, "utf8").digest("hex");
  return validateSocketPath(join(runtimeDirectory, `codex-${digest.slice(0, 24)}.sock`));
}

export function controlSocketPath(runtimeDirectory: string): string {
  return validateSocketPath(join(runtimeDirectory, "control.sock"));
}
