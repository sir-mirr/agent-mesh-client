import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { ConfigStore, ConfigValidationError } from "../src/config/store";
import { deriveLaneId, moveSelection } from "../src/tui/app";
import type { AgentMeshConfig } from "../src/config/types";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function fixture(): Promise<{ root: string; store: ConfigStore; config: AgentMeshConfig }> {
  const root = await mkdtemp("/tmp/amc-config-");
  roots.push(root);
  return {
    root,
    store: new ConfigStore(resolve(root, "config.yaml")),
    config: {
      schema_version: 1,
      revision: 0,
      hub: { base_url: "https://mesh.example", rpc_ws: "wss://rpc.mesh.example/ws" },
      lanes: [{
        id: "codex-a",
        identity: "Codex-A",
        agent_type: "ai-codex",
        enabled: true,
        runtime: {
          kind: "codex",
          workspace: root,
          reply_mode: "auto",
          timeout_seconds: 1_800,
          security: { profile: "workspace", acknowledged_risk: false },
        },
        channels: [],
      }],
      retired_channel_ids: [],
    },
  };
}

describe("ConfigStore", () => {
  test("atomically persists a private, revisioned JSON-compatible YAML config", async () => {
    const { store, config } = await fixture();
    const saved = await store.save(config);
    expect(saved.revision).toBe(1);
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(store.path, "utf8"))).toEqual(saved);
    expect((await store.load()).lanes[0]?.identity).toBe("Codex-A");
  });

  test("rejects unsafe runtime policy and malformed split Hub endpoints", async () => {
    const { store, config } = await fixture();
    config.lanes[0]!.runtime.security = {
      profile: "unrestricted",
      acknowledged_risk: false,
    };
    await expect(store.save(config)).rejects.toBeInstanceOf(ConfigValidationError);
    config.lanes[0]!.runtime.security.acknowledged_risk = true;
    config.hub = { base_url: "https://mesh.example", rpc_ws: "http://wrong.example" };
    await expect(store.save(config)).rejects.toBeInstanceOf(ConfigValidationError);
  });
});

describe("TUI lane identity", () => {
  test("derives a private local lane ID from the required Agent Identity", () => {
    expect(deriveLaneId("AgentAlpha")).toBe("agent-alpha");
    expect(deriveLaneId("Codex-A")).toBe("codex-a");
    expect(deriveLaneId("Codex-A", ["codex-a"])).toBe("codex-a-2");
  });

  test("moves horizontal choices with wrap-around", () => {
    expect(moveSelection(0, 3, 1)).toBe(1);
    expect(moveSelection(2, 3, 1)).toBe(0);
    expect(moveSelection(0, 3, -1)).toBe(2);
  });
});
