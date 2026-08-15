import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { RuntimeConfig } from "../src/config/types";
import { AntigravityAdapter } from "../src/runtime/antigravity";
import { CodexAppServerAdapter } from "../src/runtime/codex-app-server";
import { RuntimeInbox } from "../src/runtime/inbox";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "agent-mesh-runtime-test-"));
  roots.push(root);
  return root;
}

function config(
  kind: RuntimeConfig["kind"],
  workspace: string,
  command: string,
): RuntimeConfig {
  return {
    kind,
    command,
    workspace,
    reply_mode: "auto",
    timeout_seconds: 10,
    security: { profile: "workspace", acknowledged_risk: false },
  };
}

describe("RuntimeInbox", () => {
  test("claims queued work and persists conversation mappings", async () => {
    const root = await tempRoot();
    const inbox = new RuntimeInbox(root);
    await inbox.initialize();
    const turn = inbox.enqueueMesh({
      id: "msg-runtime-1",
      from: "PeerAgent",
      sent_by: "PeerAgent",
      to: "runtime-lane",
      content: "hello",
      reply_to: null,
      ts: "2026-08-15T00:00:00.000Z",
    });
    expect(inbox.claimNext()?.turnId).toBe(turn.turnId);
    expect(inbox.claimNext()).toBeNull();
    const reply = inbox.enqueueMesh({
      id: "msg-runtime-reply",
      from: "PeerAgent",
      sent_by: "PeerAgent",
      to: "runtime-lane",
      content: "reply",
      reply_to: "msg-runtime-1",
      ts: "2026-08-15T00:00:01.000Z",
    });
    expect(reply.state).toBe("OBSERVED");
    expect(inbox.claimNext()).toBeNull();
    const mapping = inbox.saveConversation({
      contextKey: "context-a",
      conversationId: "thread-a",
      workspace: root,
      runtimeKind: "codex",
    });
    expect(mapping.successfulTurns).toBe(1);
    expect(inbox.getConversation("context-a")?.conversationId).toBe("thread-a");
    expect(
      inbox.saveConversation({
        contextKey: "context-a",
        conversationId: "thread-a",
        workspace: root,
        runtimeKind: "codex",
      }).successfulTurns,
    ).toBe(2);
    inbox.close();
  });
});

describe("runtime transports", () => {
  test("runs a Codex App Server turn and resumes the thread", async () => {
    const root = await tempRoot();
    const executable = resolve(import.meta.dir, "fixtures/fake-codex-app-server.ts");
    await chmod(executable, 0o755);
    const adapter = new CodexAppServerAdapter(config("codex", root, executable));
    const base = {
      laneId: "codex-a",
      contextKey: "context",
      signal: new AbortController().signal,
      turn: {
        turnId: "turn-local",
        sourceKind: "mesh" as const,
        sourceMessageId: "msg-1",
        content: "hello",
        correlation: { from: "peer" },
        state: "RUNNING" as const,
        response: null,
        conversationId: null,
        errorCode: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    };
    const first = await adapter.run({ ...base, conversationId: null });
    expect(first).toMatchObject({
      response: "fake codex reply",
      conversationId: "thread-fake",
    });
    const second = await adapter.run({
      ...base,
      conversationId: first.conversationId,
    });
    expect(second.conversationId).toBe("thread-fake");
    await adapter.stop();
  });

  test("runs Antigravity as a bounded one-shot JSON transport", async () => {
    const root = await tempRoot();
    const executable = resolve(import.meta.dir, "fixtures/fake-antigravity.ts");
    await chmod(executable, 0o755);
    const adapter = new AntigravityAdapter(
      config("antigravity", root, executable),
    );
    const result = await adapter.run({
      laneId: "agy-a",
      contextKey: "context",
      conversationId: "agy-existing",
      signal: new AbortController().signal,
      turn: {
        turnId: "turn-local",
        sourceKind: "mesh",
        sourceMessageId: "msg-1",
        content: "hello",
        correlation: { from: "peer" },
        state: "RUNNING",
        response: null,
        conversationId: null,
        errorCode: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
    expect(result).toMatchObject({
      response: "fake antigravity reply",
      conversationId: "agy-existing",
    });
    await adapter.stop();
  });
});
