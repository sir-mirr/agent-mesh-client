import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { collectBundle } from "../src/diagnostics/bundle";
import { diagnosticRing } from "../src/diagnostics/ring-buffer";

/**
 * What the collector says when it could not collect.
 *
 * This is judgement ③ of `LOGGING-OPS.md`: *the bundle generator does not fold
 * what it could not read into what was empty.* The failure it guards is not
 * hypothetical — it is the same shape as the empty-list-200 the platform side
 * is removing from `/api/v1/admin/chat-audits/agents` this week, and as the `0`
 * that meant "could not measure" before that. Each time, an absence wearing the
 * costume of a normal answer sent someone to the wrong layer.
 *
 * Three failures are produced for real here rather than described: no config
 * file, a config file that cannot be opened, and a runtime directory with no
 * daemon behind it. The assertion is that the three come back distinguishable,
 * with a reason each, and that none of them reads as success.
 */
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  diagnosticRing.clear();
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function root(): Promise<string> {
  const path = await mkdtemp("/tmp/agent-mesh-outcome-");
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

describe("bundle outcomes", () => {
  test("a missing config file is absent, not an empty config", async () => {
    const base = await root();
    const bundle = await collectBundle({
      configFile: `${base}/nowhere.yaml`,
      stateDirectory: `${base}/state`,
      runtimeDirectory: `${base}/runtime`,
    });

    expect(bundle.config.outcome).toBe("absent");
    expect(bundle.config.value).toBeNull();
    expect(bundle.config.reason).toBe("no such file");
    expect(bundle.complete).toBe(false);
    expect(bundle.incomplete_sections).toContain("config");
  });

  test("a config file that exists and cannot be opened is unreadable and keeps its code", async () => {
    const base = await root();
    const configFile = `${base}/config.yaml`;
    await writeFile(configFile, "hub:\n  base_url: https://hub.example\n");
    await chmod(configFile, 0o000);
    cleanups.push(async () => {
      await chmod(configFile, 0o600).catch(() => undefined);
    });

    const bundle = await collectBundle({
      configFile,
      stateDirectory: `${base}/state`,
      runtimeDirectory: `${base}/runtime`,
    });

    // The distinction this file exists for: telling a user to create a config
    // they already have is worse than saying nothing, and "absent" is exactly
    // that instruction.
    expect(bundle.config.outcome).toBe("unreadable");
    expect(bundle.config.reason).toContain("EACCES");
    expect(bundle.config.value).toBeNull();
  });

  test("a stopped daemon is unavailable with that reason, and is a finding rather than an error", async () => {
    const base = await root();
    const bundle = await collectBundle({
      configFile: `${base}/config.yaml`,
      stateDirectory: `${base}/state`,
      runtimeDirectory: `${base}/runtime`,
    });

    for (const section of [bundle.daemon, bundle.hub, bundle.outbox]) {
      expect(section.outcome).toBe("unavailable");
      expect(section.reason).toBe("daemon is not running");
      expect(section.value).toBeNull();
    }
    // Half the complaints this bundle exists for are "nothing happens", and a
    // stopped daemon is the answer to those -- so collection must still finish
    // and still hand over the ring.
    expect(bundle.ring.outcome).toBe("read");
    expect(bundle.contract_pin.outcome).toBe("read");
  });

  test("incomplete_sections names every section that is not read, and complete follows it", async () => {
    const base = await root();
    const bundle = await collectBundle({
      configFile: `${base}/config.yaml`,
      stateDirectory: `${base}/state`,
      runtimeDirectory: `${base}/runtime`,
    });

    expect(bundle.incomplete_sections.sort()).toEqual(["config", "daemon", "hub", "outbox"]);
    expect(bundle.complete).toBe(bundle.incomplete_sections.length === 0);
    expect(bundle.complete).toBe(false);
  });
});
