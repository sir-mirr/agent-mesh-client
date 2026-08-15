import { afterEach, describe, expect, test } from "bun:test";
import {
  AgentIdentityConflictError,
  lookupAgentIdentity,
  provisionAgent,
} from "../src/hub/provisioning";
import type { HubEndpoints } from "../src/hub/endpoints";

const servers: Bun.Server<unknown>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function fixture(): HubEndpoints {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method === "POST") {
        const requestBody = await request.json() as { identity: string; create_only?: boolean };
        if (requestBody.create_only !== true) {
          return Response.json({ error: "create_only missing" }, { status: 400 });
        }
        if (requestBody.identity === "Registered-Agent") {
          return Response.json({
            ok: false,
            code: "IDENTITY_EXISTS",
            identity: requestBody.identity,
            error: "identity already exists",
          }, { status: 409 });
        }
        return Response.json({
          ok: true,
          identity: requestBody.identity,
          type: "ai-codex",
          description: null,
          created_at: new Date().toISOString(),
          action: "inserted",
          key: { fingerprint: "sha256:test", status: "pending" },
        }, { status: 201 });
      }
      const identity = decodeURIComponent(new URL(request.url).pathname.split("/").at(-2) ?? "");
      if (identity === "Available-Agent") {
        return Response.json(
          { ok: false, error: `identity '${identity}' is not registered` },
          { status: 404 },
        );
      }
      if (identity === "Ambiguous-Agent") {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      return Response.json({
        ok: true,
        identity,
        deleted: identity === "Retired-Agent",
        key_status: "approved",
        keys: [],
        events: [],
      });
    },
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  return { baseUrl: base, apiHttp: base, rpcWebSocket: base.replace("http:", "ws:") };
}

describe("Agent Identity lookup", () => {
  test("distinguishes an available identity from registered and retired identities", async () => {
    const endpoints = fixture();
    expect(await lookupAgentIdentity(endpoints, "Available-Agent")).toBeNull();
    expect(await lookupAgentIdentity(endpoints, "Registered-Agent")).toEqual({
      identity: "Registered-Agent",
      deleted: false,
      keyStatus: "approved",
      keys: [],
    });
    expect((await lookupAgentIdentity(endpoints, "Retired-Agent"))?.deleted).toBe(true);
  });

  test("fails closed on a non-canonical 404", async () => {
    await expect(lookupAgentIdentity(fixture(), "Ambiguous-Agent")).rejects.toThrow(
      "ambiguous 404",
    );
  });

  test("sends the atomic create-only guard and classifies identity conflicts", async () => {
    const endpoints = fixture();
    const created = await provisionAgent(endpoints, {
      identity: "Available-Agent",
      type: "ai-codex",
      public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      create_only: true,
    });
    expect(created.action).toBe("inserted");
    await expect(provisionAgent(endpoints, {
      identity: "Registered-Agent",
      type: "ai-codex",
      public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      create_only: true,
    })).rejects.toBeInstanceOf(AgentIdentityConflictError);
  });
});
