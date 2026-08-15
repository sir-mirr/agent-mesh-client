import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensurePrivateRuntimeDirectory,
  laneSocketName,
  laneSocketPath,
} from "../src/config/paths";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("runtime paths", () => {
  test("uses a stable hash rather than the raw lane ID", () => {
    const first = laneSocketName("customer/lane with spaces");
    expect(first).toBe(laneSocketName("customer/lane with spaces"));
    expect(first).toMatch(/^lane-[0-9a-f]{24}\.sock$/);
    expect(first).not.toContain("customer");
  });

  test("forces the runtime directory to user-only mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mesh-paths-"));
    temporaryDirectories.push(root);
    const runtimeDirectory = join(root, "runtime");
    await ensurePrivateRuntimeDirectory(runtimeDirectory);
    const mode = (await stat(runtimeDirectory)).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test("rejects socket paths beyond the portable safety bound", () => {
    expect(() => laneSocketPath(`/${"a".repeat(100)}`, "lane-a")).toThrow(
      "Unix socket path is too long",
    );
  });
});
