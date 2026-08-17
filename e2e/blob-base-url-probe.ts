#!/usr/bin/env bun
/**
 * Where does the hub say to upload a blob?
 *
 * `docs/running-locally.md` § 3 sets `AGENT_MESH_BLOB_BASE_URL` and explains
 * that the hub cannot work the address out for itself. Following that procedure
 * verifies every step through § 6 — and says nothing about this one. A wrong
 * value leaves the whole bring-up green, because nothing in it uploads a blob.
 *
 * So this asks the hub directly: bring one up with a deliberately wrong address
 * and read what it hands back from `mesh.audit.prepare_blobs`. If the upload URL
 * carries the wrong host, the knob is real and the procedure simply does not
 * cover it. If it carries something else, the doc's explanation is wrong and
 * that is worth more.
 *
 * Not a scenario. The contract does not describe this and neither runner should
 * grow a private expectation about it -- the point is to measure one sentence in
 * a document, once, and report the number.
 *
 * **It brings the mesh up by hand, the way the document says to.** The first
 * attempt used the harness, which sets this very variable itself
 * (`e2e-harness.ts:232`), so the injected value was overwritten and the probe
 * measured the harness rather than the sentence. A measurement whose subject is
 * overridden by the apparatus is not a measurement of the subject.
 */

import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyFingerprint, requestSignaturePreimage } from "@agent-mesh/contracts";
import { refusesDirtyTree } from "./dirty-tree";

const PLATFORM =
  process.env.AGENT_MESH_E2E_PLATFORM ??
  join(import.meta.dir, "..", "..", "agent-mesh-platform-main");

/** Somewhere nothing is listening, so a correct answer is unmistakable. */
const WRONG_BLOB_HOST = "http://127.0.0.1:9999";

function git(...args: string[]): string {
  return Bun.spawnSync(["git", "-C", PLATFORM, ...args]).stdout.toString().trim();
}

// The same refusal the scenario runner makes, for the same reason -- and it
// belongs here because this script spawns from that checkout too. The guard
// living in one entry point is a guard every other entry point walks around,
// which is what nearly happened when this file was written.
if (refusesDirtyTree({ dirty: git("status", "--porcelain") !== "", override: process.env.AGENT_MESH_E2E_ALLOW_DIRTY })) {
  process.stderr.write(
    `the platform checkout at ${PLATFORM} has uncommitted changes; this would measure a tree ` +
      `that exists in no commit. Wait, or set AGENT_MESH_E2E_ALLOW_DIRTY=1 and treat it as unreproducible.\n`,
  );
  process.exit(2);
}

const HUB_PORT = 3155;
const HTTP_PORT = 3055;
const stateDir = mkdtempSync(join(tmpdir(), "blob-probe-"));
// § 2, and skipping it is how this script first failed. The services do not
// create the directory, and the surface error is a health check naming the port
// -- which is what the document says will happen and what happened here.
const serviceState = join(stateDir, "state");
mkdirSync(serviceState, { recursive: true });
const shared = { ...process.env, AGENT_MESH_STATE_DIR: serviceState };
let output = "";
const collect = (child: ReturnType<typeof spawn>) => {
  child.stdout?.on("data", (c) => (output += c));
  child.stderr?.on("data", (c) => (output += c));
  return child;
};

// § 3 and § 4 of the document, with the blob address deliberately wrong.
const hub = collect(
  spawn("bun", ["packages/hub/src/main.ts"], {
    cwd: PLATFORM,
    env: {
      ...shared,
      AGENT_MESH_HUB_PORT: String(HUB_PORT),
      AGENT_MESH_PROXY_IDENTITIES: "http-server,http-server-dev",
      AGENT_MESH_BLOB_BASE_URL: WRONG_BLOB_HOST,
    },
    stdio: ["ignore", "pipe", "pipe"],
  }),
);
const http = collect(
  spawn("bun", ["packages/http/src/main.ts"], {
    cwd: PLATFORM,
    env: {
      ...shared,
      AGENT_MESH_HTTP_PORT: String(HTTP_PORT),
      AGENT_MESH_HUB_URL: `ws://127.0.0.1:${HUB_PORT}/ws`,
      JWT_SECRET: "local-development-only",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }),
);
const ready = {
  api_http: `http://127.0.0.1:${HUB_PORT}`,
  base_url: `http://127.0.0.1:${HTTP_PORT}`,
  rpc_ws: `ws://127.0.0.1:${HUB_PORT}/ws`,
  platform: { branch: git("rev-parse", "--abbrev-ref", "HEAD"), commit: git("rev-parse", "HEAD") },
  admin_test_handle: {
    login_url: `http://127.0.0.1:${HTTP_PORT}/auth/local`,
    body: "username=admin&password=admin",
    approve_url: `http://127.0.0.1:${HTTP_PORT}/api/v1/admin/keys/approve`,
  },
};

try {
  const deadline = Date.now() + 60_000;
  const up = async (url: string) => {
    while (Date.now() < deadline) {
      try {
        if ((await fetch(url)).ok) return;
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`${url} never answered:\n${output}`);
  };
  await up(`${ready.api_http}/health`);
  await up(`${ready.base_url}/api/v1/health`);
  process.stdout.write(`platform  ${ready.platform?.branch} ${ready.platform?.commit?.slice(0, 7)}\n`);
  process.stdout.write(`asked for AGENT_MESH_BLOB_BASE_URL=${WRONG_BLOB_HOST}\n\n`);

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "jwk" }).x!;
  const kid = keyFingerprint(raw);
  const identity = "blob-probe";

  await fetch(`${ready.api_http}/api/v1/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity, type: "ai-claude", public_key: raw }),
  });
  const login = await fetch(ready.admin_test_handle.login_url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: ready.admin_test_handle.body,
    redirect: "manual",
  });
  const cookie = login.headers.get("set-cookie")!.match(/mesh_token=[^;]+/)![0];
  await fetch(ready.admin_test_handle.approve_url, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ fingerprint: kid }),
  });

  const socket = new WebSocket(ready.rpc_ws);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
  });

  const call = (method: string, params: Record<string, unknown>) => {
    const id = `rpc_${randomUUID()}`;
    const rawParams = Buffer.from(JSON.stringify(params), "utf8");
    const nonce = `nonce_${randomUUID()}`;
    const iat = Math.floor(Date.now() / 1000);
    const answer = new Promise<any>((resolve) => {
      const onMessage = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== id) return;
        socket.removeEventListener("message", onMessage);
        resolve(message);
      };
      socket.addEventListener("message", onMessage);
    });
    socket.send(
      `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":${JSON.stringify(method)},"params":${rawParams.toString(
        "utf8",
      )},"sig":${JSON.stringify({
        alg: "ed25519",
        kid,
        nonce,
        iat,
        value: edSign(null, requestSignaturePreimage({ method, kid, nonce, iat, rawParams }), privateKey).toString(
          "base64url",
        ),
      })}}`,
    );
    return answer;
  };

  await call("mesh.connect", { identity });
  const bytes = Buffer.from("blob probe");
  const prepared = await call("mesh.audit.prepare_blobs", {
    event_id: `evt_${randomUUID()}`,
    blobs: [
      { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, name: "probe.txt" },
    ],
  });
  socket.close();

  const blob = prepared.result?.blobs?.[0];
  process.stdout.write(`prepare_blobs -> ${JSON.stringify(prepared.error ?? blob?.status)}\n`);
  const url = blob?.upload?.url;
  process.stdout.write(`upload.url    -> ${url ?? "(none)"}\n\n`);
  if (typeof url === "string") {
    const absolute = new URL(url, ready.base_url);
    const carries = absolute.origin === WRONG_BLOB_HOST;
    process.stdout.write(
      carries
        ? `The hub handed back ${absolute.origin}, which is what it was told. The knob is real and\n` +
            `the bring-up procedure does not cover it: a wrong value here leaves every step green.\n`
        : `The hub handed back ${absolute.origin}, not the ${WRONG_BLOB_HOST} it was given.\n` +
            `Either the address comes from somewhere else or the grant is relative — the doc's\n` +
            `explanation of this variable is worth rereading.\n`,
    );
  }
} finally {
  hub.kill("SIGTERM");
  http.kill("SIGTERM");
  rmSync(stateDir, { recursive: true, force: true });
}
