#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ChannelDriverClient } from "../src/channel-driver/client";
import { ConfigStore } from "../src/config/store";
import type { AgentMeshConfig, LaneConfig } from "../src/config/types";
import { AgentMeshDaemon } from "../src/daemon/agent-mesh-daemon";
import { requestControl } from "../src/daemon/host-daemon";
import {
  AgentIdentityConflictError,
  lookupAgentIdentity,
  provisionAgent,
} from "../src/hub/provisioning";

interface HarnessReady {
  base_url: string;
  rpc_ws: string;
  api_http: string;
  state_dir: string;
}

interface PendingKey {
  fingerprint: string;
  identity: string;
}

const readyFile = process.env.AGENT_MESH_E2E_READY_FILE;
if (!readyFile) {
  throw new Error("AGENT_MESH_E2E_READY_FILE must point to the platform harness ready JSON");
}

const ready = JSON.parse(await readFile(resolve(readyFile), "utf8")) as HarnessReady;
const runId = randomUUID();
// macOS sockaddr_un is short; keep the live fixture root deliberately compact.
const root = await mkdtemp("/tmp/amc-e2e-");
const configFile = resolve(root, "config.json");
const stateDirectory = resolve(root, "state");
const runtimeDirectory = resolve(root, "run");
const secretDirectory = resolve(root, "secrets");
const fakeCodex = resolve(import.meta.dir, "../test/fixtures/fake-codex-app-server.ts");
await chmod(fakeCodex, 0o755);

function lane(id: string, identity: string): LaneConfig {
  return {
    id,
    identity,
    agent_type: "ai-codex",
    enabled: true,
    runtime: {
      kind: "codex",
      command: fakeCodex,
      workspace: root,
      reply_mode: "auto",
      timeout_seconds: 30,
      security: { profile: "workspace", acknowledged_risk: false },
    },
    channels: [],
  };
}

const config: AgentMeshConfig = {
  schema_version: 1,
  revision: 0,
  hub: {
    base_url: ready.base_url,
    rpc_ws: ready.rpc_ws,
    api_http: ready.api_http,
  },
  lanes: [lane("e2e-codex-a", "E2ECodexA"), lane("e2e-codex-b", "E2ECodexB")],
  retired_channel_ids: [],
};
await new ConfigStore(configFile).save(config);

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | false>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value as T;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(200);
  }
  throw new Error(
    `${label} timed out${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
  );
}

async function adminCookie(): Promise<string> {
  const response = await fetch(`${ready.base_url}/auth/local`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=admin&password=admin",
    redirect: "manual",
  });
  const setCookie = response.headers.get("set-cookie");
  if (response.status !== 302 || !setCookie) {
    throw new Error(`Admin login failed (${response.status})`);
  }
  return setCookie.split(";", 1)[0]!;
}

async function json<T>(url: string, cookie: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      cookie,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = (await response.json()) as T;
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

const daemonOptions = {
  configFile,
  stateDirectory,
  runtimeDirectory,
  secretDirectory,
  onDiagnostic: (message, error) =>
    process.stderr.write(
      `[e2e] ${message}${error instanceof Error ? `: ${error.message}` : ""}\n`,
    ),
};
let daemon = new AgentMeshDaemon(daemonOptions);
let driver: ChannelDriverClient | null = null;
let passed = false;

try {
  await daemon.start();
  const cookie = await adminCookie();
  const pending = await waitFor("two pending identity keys", async () => {
    const result = await json<{ pending: PendingKey[] }>(
      `${ready.base_url}/api/v1/admin/keys/pending`,
      cookie,
    );
    const ours = result.pending.filter((key) =>
      key.identity === "E2ECodexA" || key.identity === "E2ECodexB"
    );
    return ours.length === 2 ? ours : null;
  });
  for (const key of pending) {
    await json(`${ready.base_url}/api/v1/admin/keys/approve`, cookie, {
      method: "POST",
      body: JSON.stringify({ fingerprint: key.fingerprint }),
    });
  }

  await waitFor("both signed lanes connected", async () => {
    const lanes = await requestControl(runtimeDirectory, "lane.list", {}) as Array<{
      lane_id: string;
      hub: { state: string; audit?: { running: boolean } } | null;
    }>;
    return lanes.length === 2 && lanes.every((item) => item.hub?.state === "connected")
      ? lanes
      : null;
  }, 45_000);

  const sent = await requestControl(runtimeDirectory, "mesh.send", {
    lane_id: "e2e-codex-a",
    to: "E2ECodexB",
    content: "안녕하세요 — 서명된 Agent Mesh E2E 메시지입니다.",
    client_message_id: `e2e-unicode-${runId}`,
  }) as { id: string; status: string; duplicate?: boolean };
  if (sent.status !== "delivered") throw new Error(`Mesh send was ${sent.status}`);
  const replayed = await requestControl(runtimeDirectory, "mesh.send", {
    lane_id: "e2e-codex-a",
    to: "E2ECodexB",
    content: "안녕하세요 — 서명된 Agent Mesh E2E 메시지입니다.",
    client_message_id: `e2e-unicode-${runId}`,
  }) as { id: string; status: string; duplicate?: boolean };
  if (replayed.id !== sent.id || replayed.duplicate !== true) {
    throw new Error("mesh.send client_message_id replay was not idempotent");
  }

  await waitFor("one runtime reply without a reply loop", async () => {
    const inboxA = await requestControl(runtimeDirectory, "mesh.inbox", {
      lane_id: "e2e-codex-a",
    }) as Array<{ sourceKind: string; state: string; correlation: Record<string, unknown> }>;
    const inboxB = await requestControl(runtimeDirectory, "mesh.inbox", {
      lane_id: "e2e-codex-b",
    }) as Array<{ sourceKind: string; state: string }>;
    const observed = inboxA.filter(
      (turn) => turn.sourceKind === "mesh" && turn.state === "OBSERVED",
    );
    const completed = inboxB.filter(
      (turn) => turn.sourceKind === "mesh" && turn.state === "COMPLETED",
    );
    return observed.length === 1 && completed.length === 1
      ? { observed: observed.length, completed: completed.length }
      : null;
  });
  await Bun.sleep(1_000);
  const inboxA = await requestControl(runtimeDirectory, "mesh.inbox", {
    lane_id: "e2e-codex-a",
  }) as Array<{ sourceKind: string; state: string }>;
  if (inboxA.filter((turn) => turn.sourceKind === "mesh").length !== 1) {
    throw new Error("A mesh reply loop was detected");
  }

  const staging = resolve(root, "driver-staging");
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const attachment = Buffer.from("Agent Mesh attachment: 한글 원본\n", "utf8");
  const attachmentPath = resolve(staging, "evidence.txt");
  await writeFile(attachmentPath, attachment, { mode: 0o600 });
  const delivered: Array<Record<string, unknown>> = [];
  driver = new ChannelDriverClient(runtimeDirectory, {
    laneId: "e2e-codex-b",
    driverInstanceId: "e2e-driver",
    provider: "discord",
    accountRef: "e2e-account",
    stagingRoot: staging,
    capabilities: ["message.receive", "message.send"],
  });
  driver.onRequest(async (method, params) => {
    if (method !== "channel.message.send") throw new Error(`Unexpected ${method}`);
    delivered.push(params);
    return {
      provider_message_id: `provider-reply-${delivered.length}`,
      provider_timestamp: new Date().toISOString(),
      duplicate: false,
    };
  });
  await driver.connect();
  const inbound = await driver.call("channel.message.received", {
    driver_instance_id: "e2e-driver",
    provider_event_id: "provider-event-1",
    provider_message_id: "provider-message-1",
    sender: { provider_user_id: "user-1", display_name: "E2E User" },
    conversation: {
      account_ref: "e2e-account",
      conversation_ref: "e2e-channel",
      thread_ref: null,
    },
    text: "첨부가 있는 채널 메시지입니다.",
    attachments: [{
      attachment_id: "attachment-1",
      filename: "evidence.txt",
      media_type: "text/plain",
      size: attachment.byteLength,
      sha256: createHash("sha256").update(attachment).digest("hex"),
      local_path: attachmentPath,
    }],
    provider_timestamp: new Date().toISOString(),
  }) as { accepted: boolean; audit_event_id: string };
  if (!inbound.accepted) throw new Error("Channel inbound was not durably accepted");

  await waitFor("runtime channel reply", async () => delivered.length === 1 ? delivered[0]! : null);
  const summary = await waitFor("Hub final ACK for all channel audit events", async () => {
    const value = await requestControl(runtimeDirectory, "outbox.summary", {
      lane_id: "e2e-codex-b",
    }) as { pending: number; retry: number; deadLetter: number; acked: number };
    return value.pending === 0 && value.retry === 0 && value.deadLetter === 0 && value.acked >= 3
      ? value
      : null;
  }, 45_000);

  const audit = await waitFor("audit query exposes attachment and three event types", async () => {
    const result = await json<{
      events: Array<{
        event_id: string;
        event_type: string;
        identity: string;
        attachments: Array<{ sha256: string; size: number; name: string }>;
      }>;
    }>(`${ready.base_url}/api/v1/audit/events?identity=E2ECodexB&limit=200`, cookie);
    const eventTypes = new Set(result.events.map((event) => event.event_type));
    const inboundEvent = result.events.find((event) => event.event_id === inbound.audit_event_id);
    return inboundEvent?.attachments.length === 1 &&
      eventTypes.has("channel.inbound.received") &&
      eventTypes.has("channel.outbound.requested") &&
      eventTypes.has("channel.outbound.succeeded")
      ? { events: result.events, inboundEvent }
      : null;
  }, 30_000);

  const endpoints = {
    baseUrl: ready.base_url,
    rpcWebSocket: ready.rpc_ws,
    apiHttp: ready.api_http,
  };
  const beforeConflict = await lookupAgentIdentity(endpoints, "E2ECodexA");
  if (!beforeConflict) throw new Error("Registered E2E identity disappeared before conflict test");
  const takeoverPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const takeoverPublicKey = Buffer.from(
    await crypto.subtle.exportKey("raw", takeoverPair.publicKey),
  ).toString("base64url");
  let conflictCode: string | null = null;
  try {
    await provisionAgent(endpoints, {
      identity: "E2ECodexA",
      type: "ai-codex",
      public_key: takeoverPublicKey,
      create_only: true,
    });
  } catch (error) {
    if (!(error instanceof AgentIdentityConflictError)) throw error;
    conflictCode = error.code;
  }
  if (conflictCode !== "IDENTITY_EXISTS") {
    throw new Error("Atomic create-only provisioning did not reject an identity takeover");
  }
  const afterConflict = await lookupAgentIdentity(endpoints, "E2ECodexA");
  if (JSON.stringify(afterConflict?.keys) !== JSON.stringify(beforeConflict.keys)) {
    throw new Error("Rejected identity takeover changed the original key set");
  }

  driver.close();
  driver = null;
  await daemon.stop();
  daemon = new AgentMeshDaemon(daemonOptions);
  await daemon.start();
  await waitFor("daemon restart reuses its approved identity key", async () => {
    const lanes = await requestControl(runtimeDirectory, "lane.list", {}) as Array<{
      hub: { state: string } | null;
    }>;
    return lanes.length === 2 && lanes.every((item) => item.hub?.state === "connected")
      ? lanes
      : null;
  }, 45_000);

  passed = true;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    harness_state: ready.state_dir,
    client_state: root,
    mesh: {
      message_id: sent.id,
      idempotent_replay: true,
      reply_loop_guard: true,
      identity_takeover_guard: conflictCode,
      restart_identity_reused: true,
    },
    channel: { delivered: delivered.length, inbound_audit_event_id: inbound.audit_event_id },
    audit: { acked: summary.acked, queried: audit.events.length, attachment: audit.inboundEvent.attachments[0] },
  }, null, 2)}\n`);
} finally {
  driver?.close();
  await daemon.stop().catch(() => undefined);
  if (passed && process.env.AGENT_MESH_E2E_KEEP !== "1") {
    await rm(root, { recursive: true });
  } else {
    process.stderr.write(`[e2e] client state preserved at ${root}\n`);
  }
}
