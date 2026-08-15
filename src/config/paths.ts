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

export function controlSocketPath(runtimeDirectory: string): string {
  return validateSocketPath(join(runtimeDirectory, "control.sock"));
}
