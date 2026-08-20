#!/usr/bin/env bun
/**
 * Runs the shared `E2E_SCENARIOS` from `@agent-mesh/contracts` against a real mesh.
 *
 * The scenarios live in the contract because each side used to keep its own
 * list, and neither could replay the other's -- so "both sides pass" was a
 * claim nobody could check. This is the client's interpreter for that list.
 *
 * It holds no expectations of its own. Every assertion comes from the scenario;
 * if this file starts deciding what a correct answer looks like, a green run
 * here stops meaning the same thing as a green run there, which is the
 * situation the shared artefact exists to end. That rule is why nothing below
 * adds a field the scenario did not ask for -- an earlier draft sent
 * `create_only: true` on every provision, which turned E2E-TYPE-001's expected
 * `200` into a `409` the scenario never described.
 *
 * Nothing is skipped. § 17.3 used to allow a verb only one side could run, and
 * that permission was the hole: three clauses were held by one implementation
 * while both reports read green. A verb this runner cannot perform is a
 * failure, and the gap belongs in the mesh's surfaces rather than in a runner
 * reaching past them.
 *
 * ## Why it brings its own mesh
 *
 * The scenarios share state on purpose -- E2E-REVOKE-001 sends to an identity
 * E2E-KEY-002 provisioned -- so they are one ordered run against one clean
 * mesh, not twelve independent cases. Replaying them against a mesh that has
 * already run them answers `IDENTITY_EXISTS` to step 1 and measures nothing.
 * The platform's `e2e:harness` is the sanctioned way to get that mesh; its
 * ready file also publishes the admin approval routes, which is the one thing
 * § 10.2 keeps out of a participant's reach.
 *
 * A scenario carrying `mesh` gets a harness of its own, since its requirement
 * is part of what it claims: "with a two-second lease, an unacknowledged batch
 * comes back" is not shown by a mesh whose lease is thirty.
 */

import { spawn } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as edSign,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  E2E_SCENARIOS,
  formatRestAuthorization,
  keyFingerprint,
  requestSignaturePreimage,
  restSignaturePreimage,
  type ExpectHttp,
  type Scenario,
  type Step,
} from "@agent-mesh/contracts";
import { refusesDirtyTree } from "./dirty-tree";
import { mayAlign, missingCheckoutMessage } from "./platform-checkout";
import { tallyMismatch } from "./scenario-tally";
import { passFirstLoginGate } from "./first-login-gate";
import { duplicateIdMessage, duplicateIds } from "./scenario-ids";

/**
 * The platform checkout whose harness this run drives.
 *
 * `-main` is not decoration. The sibling directory without it is a feature
 * worktree, and a run against it once produced a confident bug report about a
 * refusal that had shipped forty commits earlier -- the mesh was fine and the
 * tree was old. Which tree answered is part of the result, which is why the
 * report prints the revision the ready file declares.
 */
/**
 * Bring the owned checkout to `origin/main` before anything measures it.
 *
 * Done once, at start, so every mesh in a run sees the same tree. It refuses a
 * dirty checkout rather than discarding work -- this one should never be dirty,
 * and if it is, something is using it in a way nobody wrote down.
 */
function alignPlatformCheckout(): void {
  if (!existsSync(PLATFORM)) {
    process.stderr.write(`${missingCheckoutMessage(PLATFORM)}\n`);
    process.exit(2);
  }
  if (!mayAlign(PLATFORM_OVERRIDE)) return;
  const run = (...args: string[]) => Bun.spawnSync(["git", "-C", PLATFORM, ...args]);
  if (run("status", "--porcelain").stdout.toString().trim() !== "") {
    process.stderr.write(
      `${PLATFORM} has uncommitted changes. It is this runner's checkout and nothing should be ` +
        `editing it; aligning would discard whatever that is.\n`,
    );
    process.exit(2);
  }
  const fetched = run("fetch", "--quiet", "origin");
  if (fetched.exitCode !== 0) {
    process.stderr.write(
      `git fetch failed in ${PLATFORM}: ${fetched.stderr.toString().trim()}\n` +
        `The run would measure whatever was last fetched, which is not what origin/main says.\n`,
    );
    process.exit(2);
  }
  const moved = run("checkout", "--quiet", "--detach", "origin/main");
  if (moved.exitCode !== 0) {
    process.stderr.write(`git checkout origin/main failed: ${moved.stderr.toString().trim()}\n`);
    process.exit(2);
  }
}

const PLATFORM_OVERRIDE = process.env.AGENT_MESH_E2E_PLATFORM;
const PLATFORM =
  PLATFORM_OVERRIDE && PLATFORM_OVERRIDE !== ""
    ? PLATFORM_OVERRIDE
    : join(import.meta.dir, "..", "..", "agent-mesh-platform-e2e");

/**
 * There is no skip list, and § 17.3 no longer permits one.
 *
 * Three clauses used to sit behind `expectStored`, a verb only the platform
 * could run against its own store. Skipping it was legal, and being legal is
 * what hid the hole: observed source, audit-read tracing and the type-change
 * event were each held by one implementation while both reports read green.
 * They are now asked through the operator's own routes, which is the better
 * question anyway -- a trace nobody can query does not serve the operator it
 * exists for. A verb this runner cannot perform is now a failure, and the fix
 * belongs in the mesh's surfaces rather than in a runner reaching past them.
 */

interface Mesh {
  /** Hub: provisioning and the signed inbox/outbox surface. */
  apiHttp: string;
  /** Hub JSON-RPC socket, for `mesh.connect`. */
  rpcWs: string;
  /** The operator-facing service: admin routes and the audit read surface. */
  baseUrl: string;
  approveUrl: string;
  revokeUrl: string;
  loginUrl: string;
  loginBody: string;
  /** What answered, as the harness declares it. Printed with the result. */
  provenance: string;
  stop: () => void;
}

interface Identity {
  name: string;
  publicKey: string;
  privateKey: KeyObject;
  fingerprint: string;
}

interface StepResult {
  step: number;
  verb: string;
  outcome: "passed" | "failed";
  detail?: string;
}

interface ScenarioResult {
  id: string;
  clause: string;
  outcome: "passed" | "failed";
  steps: StepResult[];
}

class StepFailure extends Error {}

function fail(message: string): never {
  throw new StepFailure(message);
}

function makeIdentity(name: string): Identity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.x) throw new Error("generated key has no raw public component");
  return { name, publicKey: jwk.x, privateKey, fingerprint: keyFingerprint(jwk.x) };
}

// ---------------------------------------------------------------------------
// The mesh
// ---------------------------------------------------------------------------

async function startMesh(requirement: Scenario["mesh"]): Promise<Mesh> {
  const stateDir = mkdtempSync(join(tmpdir(), "mesh-e2e-"));
  const readyFile = join(stateDir, "ready.json");
  // Asked for by flag rather than arranged through the environment. Setting
  // `AGENT_MESH_RECEIVE_LEASE_SECONDS` behind the harness's back worked, but a
  // requirement each runner satisfies its own way is no longer one requirement,
  // and a harness that never saw the number cannot say it honoured it.
  const child = spawn(
    "bun",
    [
      "run",
      "e2e:harness",
      "--",
      "--ready-file",
      readyFile,
      "--state-dir",
      join(stateDir, "state"),
      ...(requirement?.receiveLeaseSeconds !== undefined
        ? ["--receive-lease-seconds", String(requirement.receiveLeaseSeconds)]
        : []),
    ],
    { cwd: PLATFORM, stdio: ["ignore", "pipe", "pipe"] },
  );
  let harnessOutput = "";
  child.stdout?.on("data", (chunk) => (harnessOutput += chunk));
  child.stderr?.on("data", (chunk) => (harnessOutput += chunk));

  const deadline = Date.now() + 60_000;
  while (!existsSync(readyFile)) {
    if (child.exitCode !== null) {
      throw new Error(`harness exited (${child.exitCode}) before it was ready:\n${harnessOutput}`);
    }
    if (Date.now() > deadline) {
      child.kill("SIGTERM");
      throw new Error(`harness did not become ready within 60s:\n${harnessOutput}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const ready = JSON.parse(readFileSync(readyFile, "utf8"));
  const handle = ready.admin_test_handle;
  const platform = ready.platform ?? {};
  // Verified against what the mesh says it applied, not against what was asked.
  // A flag the harness silently ignored would leave E2E-RECEIVE-002 passing
  // without ever reaching the lapse it exists to show.
  const applied = ready.mesh_config?.receive_lease_seconds ?? null;
  if (requirement?.receiveLeaseSeconds !== undefined && applied !== requirement.receiveLeaseSeconds) {
    child.kill("SIGTERM");
    throw new Error(
      `harness applied receive_lease_seconds=${applied}, scenario requires ${requirement.receiveLeaseSeconds}`,
    );
  }
  // A dirty platform tree is not a measurement.
  //
  // The harness is spawned from the platform checkout, so its hub is whatever
  // that working tree says right now — including a guard the other side has
  // deliberately removed while running its own mutation set. That happened: a
  // run reported 10/18 with `SIGNATURE_INVALID` everywhere, minutes after
  // 18/18 on the same commit, because the tree was mid-mutation. Reporting
  // that as a contract mismatch would have sent someone after a defect that
  // does not exist in any commit.
  //
  // Refusing rather than warning, for the reason `runMutation` refuses a dirty
  // tree: a result nobody can reproduce is worse than no result. Ports, state
  // directories and ready files are isolated per harness; the source tree is
  // the one thing two agents share, and an earlier answer of mine said there
  // was no conflict after checking only the first three.
  const dirty = platform.dirty === true || platform.dirty === "true";
  if (refusesDirtyTree({ dirty: platform.dirty, override: process.env.AGENT_MESH_E2E_ALLOW_DIRTY })) {
    child.kill("SIGTERM");
    throw new Error(
      `the platform checkout at ${PLATFORM} has uncommitted changes, so this run would measure ` +
        `a tree that exists in no commit. Wait for it to settle, or set AGENT_MESH_E2E_ALLOW_DIRTY=1 ` +
        `to run anyway and treat the result as unreproducible.`,
    );
  }
  return {
    provenance: `${platform.branch ?? "?"} ${platform.commit ?? "unknown"}${dirty ? " (dirty)" : ""}`,
    apiHttp: ready.api_http,
    rpcWs: ready.rpc_ws,
    baseUrl: ready.base_url,
    // Read from the ready file rather than hardcoded: the harness is what knows
    // which process serves approval, and a runner guessing that gets a 404 that
    // looks like a missing feature.
    approveUrl: handle.approve_url,
    revokeUrl: handle.revoke_url,
    loginUrl: handle.login_url,
    loginBody: handle.body,
    stop: () => {
      child.kill("SIGTERM");
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

interface HttpOutcome {
  status: number;
  body: any;
}

/** A REST call, signed as `identity` when one is given. */
async function http(
  identity: Identity | null,
  base: string,
  method: string,
  path: string,
  body?: unknown,
  cookie?: string,
): Promise<HttpOutcome> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (payload) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (identity) {
    const nonce = `nonce_${randomUUID()}`;
    const iat = Math.floor(Date.now() / 1000);
    headers.authorization = formatRestAuthorization({
      kid: identity.fingerprint,
      nonce,
      iat,
      signature: edSign(
        null,
        restSignaturePreimage({
          method,
          path,
          kid: identity.fingerprint,
          nonce,
          iat,
          // Empty string, not the digest of an empty string. The contract says
          // so and the hub agrees; hashing unconditionally signs a preimage the
          // verifier never builds, which fails only on the bodyless
          // methods -- so every signed POST passed while DELETE could not work.
          bodySha256: payload ? createHash("sha256").update(payload, "utf8").digest("hex") : "",
        }),
        identity.privateKey,
      ).toString("base64url"),
    });
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(payload ? { body: payload } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  // A stream answers its status and then stays open. Reading to the end waits
  // for a close that is not coming, and the scenario times out having already
  // been told what it asked -- so three routes that publish over SSE could be
  // asserted for their refusal and never for their pass.
  //
  // Bounded rather than skipped: the body is still read when there is one, and
  // a route that hangs *instead* of answering never gets here, because `fetch`
  // itself resolves on the headers and its own timeout covers that.
  const text = await Promise.race([
    response.text(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
  ]);
  if (text === null) {
    try {
      await response.body?.cancel();
    } catch {
      // Already gone; the status is what the scenario asked for.
    }
    return { status: response.status, body: { streaming: true } };
  }
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A non-JSON body is still evidence; the assertion decides whether it matters.
  }
  return { status: response.status, body: parsed };
}

/**
 * A socket a scenario is deliberately keeping open.
 *
 * `since` counts pushes from the last `expectPushed` rather than from connect.
 * A held socket receives at any time, so "how many" means nothing without
 * "since when", and a cumulative count would make each expectation depend on
 * the steps above it -- inserting one step would falsify every one below.
 */
interface Held {
  socket: WebSocket;
  since: () => number;
  clear: () => void;
}

interface RpcOutcome {
  error: { code: number; message: string; data?: any } | null;
  result: unknown;
}

/**
 * One JSON-RPC call over a fresh signed socket.
 *
 * A socket per call rather than a pool: `connect` is the only verb that needs
 * one, and holding sockets open across scenarios would make presence -- which
 * decides `delivered` vs `pending` -- depend on the runner's bookkeeping rather
 * than on what the scenario said.
 */
async function rpc(
  mesh: Mesh,
  identity: Identity,
  method: string,
  params: Record<string, unknown>,
  /**
   * How many server-pushed `mesh.message` notifications to wait for after the
   * call succeeds, or null to close as soon as it answers.
   *
   * Polled to a deadline rather than slept on. A fixed sleep is either too long
   * for every run or too short for one, and the short one fails as a flake --
   * which reads as the guarantee not existing rather than as the test being
   * impatient.
   */
  expectDelivered: number | null = null,
  /** Keep the socket open and return it, for `hold`. */
  keepOpen = false,
  /**
   * Wait for the hub to close, and report the code it sent.
   *
   * The refusals in § 8.1 answer and then close about ten milliseconds later. A
   * runner that reads the answer and drops the socket never observes the second
   * half, so a hub that refused and then held the socket open forever would pass
   * every scenario about the refusal.
   */
  awaitClose = false,
): Promise<RpcOutcome & { delivered: number; held: Held | null; closeCode: number | null }> {
  const socket = new WebSocket(mesh.rpcWs);
  let kept: Held | null = null;
  let closeCode: number | null = null;
  const closed = new Promise<void>((resolve) => {
    socket.addEventListener("close", (event) => {
      closeCode = (event as CloseEvent).code;
      resolve();
    }, { once: true });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("hub socket open timed out")), 15_000);
      socket.addEventListener("open", () => (clearTimeout(timer), resolve()), { once: true });
      socket.addEventListener("error", () => (clearTimeout(timer), reject(new Error("hub socket failed to open"))), {
        once: true,
      });
    });
    const id = `rpc_${randomUUID()}`;
    const rawParams = Buffer.from(JSON.stringify(params), "utf8");
    const nonce = `nonce_${randomUUID()}`;
    const iat = Math.floor(Date.now() / 1000);
    const signature = {
      alg: "ed25519",
      kid: identity.fingerprint,
      nonce,
      iat,
      value: edSign(
        null,
        requestSignaturePreimage({ method, kid: identity.fingerprint, nonce, iat, rawParams }),
        identity.privateKey,
      ).toString("base64url"),
    };
    // Counted from the moment the socket opens, not from after the call
    // returns: the hub may push before the response is written, and a listener
    // attached later would miss exactly the delivery under test.
    let delivered = 0;
    let cleared = 0;
    socket.addEventListener("message", (event) => {
      let message: any;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.method === "mesh.message") delivered += 1;
    });
    const answer = new Promise<RpcOutcome>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`hub request timed out: ${method}`)), 20_000);
      socket.addEventListener("message", (event) => {
        let message: any;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.id !== id) return; // Server-initiated notifications are not this answer.
        clearTimeout(timer);
        resolve({ error: message.error ?? null, result: message.result });
      });
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        reject(new Error(`hub closed the socket during ${method}`));
      });
    });
    socket.send(
      `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":${JSON.stringify(method)},"params":${rawParams.toString(
        "utf8",
      )},"sig":${JSON.stringify(signature)}}`,
    );
    const outcome = await answer;
    if (expectDelivered !== null && !outcome.error) {
      const deadline = Date.now() + 15_000;
      while (delivered < expectDelivered && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (keepOpen && !outcome.error) {
      // The counter is read through a getter so `expectPushed` sees pushes that
      // arrive after this call returns, and can clear it without the closure
      // above losing track.
      kept = { socket, since: () => delivered - cleared, clear: () => (cleared = delivered) };
      return { ...outcome, delivered, held: kept, closeCode };
    }
    // Only where nothing is being held: a socket the scenario keeps open is one
    // the hub is not expected to close, and waiting on it would spend the
    // timeout on every held connect.
    if (awaitClose) {
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
    }
    return { ...outcome, delivered, held: null, closeCode };
  } finally {
    if (!kept) {
      try {
        socket.close();
      } catch {
        // Closing a socket that never opened is not a scenario outcome.
      }
    }
  }
}

/**
 * One admin session per mesh.
 *
 * The seeded account must change its password before it may do anything else,
 * so the first login here changes it -- which kills the seeded password. A
 * second login with the credentials the ready file carries would then fail, and
 * the failure would name key approval rather than the login that caused it.
 */
const adminSessions = new Map<Mesh, string>();

/** Long enough for the server's rule, and not the one it replaces. */
const RUNNER_ADMIN_PASSWORD = "e2e-runner-password";

async function adminCookie(mesh: Mesh): Promise<string> {
  const existing = adminSessions.get(mesh);
  if (existing) return existing;
  const response = await fetch(mesh.loginUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: mesh.loginBody,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const token = response.headers.get("set-cookie")?.match(/mesh_token=([^;]+)/)?.[1];
  if (!token) fail(`admin login did not return a session (HTTP ${response.status})`);
  const cookie = `mesh_token=${token}`;
  const origin = new URL(mesh.loginUrl).origin;
  const current = new URLSearchParams(mesh.loginBody).get("password") ?? "";
  await passFirstLoginGate(origin, cookie, current, RUNNER_ADMIN_PASSWORD);
  adminSessions.set(mesh, cookie);
  return cookie;
}



// ---------------------------------------------------------------------------
// Assertions, all of them the scenario's
// ---------------------------------------------------------------------------

function short(value: unknown): string {
  return JSON.stringify(value).slice(0, 240);
}

/**
 * Replaces `{{name}}` with a bound value. Substitution, never evaluation.
 *
 * An unbound name is an error rather than a literal left in place. A `DELETE
 * /api/v1/outbox/{{taken}}` that reached the mesh verbatim would answer 404 --
 * the status a later step legitimately expects -- so a missing binding would
 * read as the scenario passing.
 */
function substitute<T>(value: T, bindings: Map<string, string>): T {
  if (typeof value === "string") {
    return value.replace(/\{\{([^}]+)\}\}/g, (_, name: string) => {
      const bound = bindings.get(name);
      if (bound === undefined) fail(`no binding for {{${name}}}`);
      return bound;
    }) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, bindings)) as unknown as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substitute(item, bindings)]),
    ) as T;
  }
  return value;
}

/** Reads a dotted path, distinguishing "absent" from a stored `undefined`. */
function atPath(body: unknown, path: string): { found: boolean; value: unknown } {
  let cursor: any = body;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || !(segment in cursor)) {
      return { found: false, value: undefined };
    }
    cursor = cursor[segment];
  }
  return { found: true, value: cursor };
}

function assertHttp(expect: ExpectHttp | undefined, got: HttpOutcome): void {
  if (!expect) return;
  if (got.status !== expect.status) fail(`expected HTTP ${expect.status}, got ${got.status}: ${short(got.body)}`);
  if (expect.code !== undefined && got.body?.code !== expect.code) {
    fail(`expected body code ${expect.code}, got ${short(got.body)}`);
  }
  for (const [path, wanted] of Object.entries(expect.body ?? {})) {
    const { found, value } = atPath(got.body, path);
    // `null` means absent or null -- how a scenario says a filter matched
    // nothing. Requiring the path to exist here would fail every one of those,
    // since a route that correctly returns no rows has no `events.0` to read.
    if (wanted === null) {
      if (found && value !== null) {
        fail(`expected no ${path}, got ${JSON.stringify(value)}: ${short(got.body)}`);
      }
      continue;
    }
    // Otherwise absent is reported as absent rather than as a mismatch against
    // `undefined`: a renamed field and a wrong value are different defects.
    if (!found) fail(`expected ${path} = ${JSON.stringify(wanted)}, but the body has no ${path}: ${short(got.body)}`);
    if (value !== wanted) {
      fail(`expected ${path} = ${JSON.stringify(wanted)}, got ${JSON.stringify(value)}`);
    }
  }
}

function assertRpc(
  expect:
    | {
        error?: number | null;
        dataCode?: string;
        data?: Record<string, string | number | boolean | null>;
      }
    | undefined,
  got: RpcOutcome,
): void {
  if (!expect) return;
  if (expect.error === null) {
    if (got.error) fail(`expected success, got error ${short(got.error)}`);
  } else if (expect.error !== undefined) {
    if (got.error?.code !== expect.error) fail(`expected error ${expect.error}, got ${short(got.error ?? got.result)}`);
  }
  if (expect.dataCode !== undefined && got.error?.data?.code !== expect.dataCode) {
    fail(`expected data.code ${expect.dataCode}, got ${short(got.error)}`);
  }
  // Dotted paths into `error.data`, the same shape and the same restraint as
  // `ExpectHttp.body`. The contract made `key_status` a MUST before anything
  // could assert it, so the two states the clause exists to separate were
  // indistinguishable to the only thing that checks the clause.
  for (const [path, wanted] of Object.entries(expect.data ?? {})) {
    // `atPath`, not a second walker: two implementations of "absent or null"
    // drift, and this one would drift toward whichever refusal was written last.
    const { found, value } = atPath(got.error?.data, path);
    if (wanted === null) {
      if (found && value !== null) fail(`expected no data.${path}, got ${JSON.stringify(value)}`);
      continue;
    }
    if (!found) fail(`expected data.${path} = ${JSON.stringify(wanted)}, but the error carries no ${path}: ${short(got.error)}`);
    if (value !== wanted) fail(`expected data.${path} = ${JSON.stringify(wanted)}, got ${JSON.stringify(value)}`);
  }
}

/**
 * The signed REST surfaces answer JSON-RPC errors in an HTTP envelope.
 *
 * The status is read first. A 404 carrying the plain string "Not Found" has
 * neither `ok: false` nor an `error` object, so it used to arrive here as a
 * success -- which is how a `send` against a route that had been renamed away
 * passed, and left the scenario failing two steps later on a message that was
 * never sent.
 */
function asRpcOutcome(got: HttpOutcome): RpcOutcome {
  if (got.status < 200 || got.status >= 300) {
    const error = typeof got.body?.error === "object" ? got.body.error : null;
    return {
      error: {
        code: error?.code ?? got.body?.rpc_code ?? got.status,
        message: error?.message ?? String(got.body?.error ?? got.body ?? ""),
        data: error?.data ?? (got.body?.code ? { code: got.body.code } : undefined),
      },
      result: null,
    };
  }
  if (got.body?.ok === false || got.body?.error) {
    const error = typeof got.body?.error === "object" ? got.body.error : null;
    return {
      error: {
        code: error?.code ?? got.body?.rpc_code ?? got.status,
        message: error?.message ?? String(got.body?.error ?? ""),
        data: error?.data ?? (got.body?.code ? { code: got.body.code } : undefined),
      },
      result: null,
    };
  }
  return { error: null, result: got.body };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Identities outlive a scenario: the set is one ordered run against one mesh. */
type Registry = Map<string, Identity>;

/** Captures the paths a step asked to remember. */
function applyBind(
  bind: Record<string, string> | undefined,
  body: unknown,
  bindings: Map<string, string>,
): void {
  for (const [name, path] of Object.entries(bind ?? {})) {
    const { found, value } = atPath(body, path);
    if (!found) fail(`cannot bind ${name}: the response has no ${path}: ${short(body)}`);
    bindings.set(name, String(value));
  }
}

async function runStep(
  mesh: Mesh,
  registry: Registry,
  leases: Map<string, string[]>,
  bindings: Map<string, string>,
  held: Map<string, Held>,
  raw: Step,
): Promise<void> {
  // Every string in the step, rather than the three places the contract names.
  //
  // It documents `path`, `body` and `expect.body`, and `E2E-REPLY-001` puts
  // `{{mailId}}` in `replyTo` -- a fourth. Enumerating meant that value went to
  // the hub verbatim, which made a reply look like an ordinary send, which is
  // pushed; the scenario then failed on the push and pointed at the hub. The
  // list was right when it was written and the vocabulary grew past it.
  //
  // Substituting everything cannot fall behind the vocabulary that way, and it
  // costs nothing: a scenario has no reason to carry a literal `{{`, and an
  // unbound name still fails loudly wherever it appears.
  const step = substitute(raw, bindings);

  switch (step.do) {
    case "provision": {
      let identity = registry.get(step.identity);
      if (step.reuseKeyOf) {
        const source = registry.get(step.reuseKeyOf);
        if (!source) fail(`no key to reuse: ${step.reuseKeyOf} was never provisioned`);
        identity = { ...source, name: step.identity };
      } else if (step.key === true || !identity) {
        identity = makeIdentity(step.identity);
      }
      // Recorded even when the call is expected to be refused: a later step may
      // need this key to show that the refusal held.
      registry.set(step.identity, identity!);
      // Pre-bound because no response carries it -- the fingerprint exists in
      // this runner and nowhere on the wire, so `bind` cannot reach it.
      bindings.set(`fingerprint:${step.identity}`, identity!.fingerprint);
      const got = await http(null, mesh.apiHttp, "POST", "/api/v1/agents", {
        identity: step.identity,
        type: step.type,
        ...(step.key === false ? {} : { public_key: identity!.publicKey }),
        ...(step.extra ?? {}),
      });
      assertHttp(step.expect, got);
      return;
    }

    case "approve":
    case "revoke": {
      const identity = registry.get(step.identity);
      if (!identity) fail(`${step.identity} was never provisioned in this run`);
      // Addressed by fingerprint, not identity: approving "whatever is pending
      // for X" approves whatever landed last, including a key that arrived
      // after the operator read the screen.
      const response = await fetch(step.do === "approve" ? mesh.approveUrl : mesh.revokeUrl, {
        method: "POST",
        headers: { cookie: await adminCookie(mesh), "content-type": "application/json" },
        body: JSON.stringify({
          fingerprint: identity.fingerprint,
          ...(step.do === "revoke" ? { reason: step.reason } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) fail(`${step.do} returned HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`);
      return;
    }

    case "connect": {
      // A correctly signed stranger: a key this run generated and never sent to
      // `POST /api/v1/agents`, which is the one state § 8.1 answers -32011 to.
      // Deliberately not recorded in the registry -- it is not an identity the
      // mesh knows, and a later step naming it should fail as unprovisioned.
      const identity = step.ephemeralKey === true
        ? makeIdentity(step.identity)
        : registry.get(step.identity);
      if (!identity) fail(`${step.identity} was never provisioned in this run`);
      const got = await rpc(
        mesh,
        identity,
        "mesh.connect",
        { identity: step.identity },
        step.expectDelivered ?? null,
        step.hold === true,
        step.expectClose !== undefined,
      );
      assertRpc(step.expect, got);
      if (step.expectClose !== undefined && got.closeCode !== step.expectClose) {
        fail(
          `expected the hub to close with ${step.expectClose}, got ` +
            `${got.closeCode === null ? "no close within 5s" : got.closeCode}`,
        );
      }
      if (step.expectDelivered !== undefined && got.delivered !== step.expectDelivered) {
        fail(`expected ${step.expectDelivered} pushed message(s) after connect, got ${got.delivered}`);
      }
      if (got.held) {
        held.get(step.identity)?.socket.close();
        held.set(step.identity, got.held);
      }
      return;
    }

    case "disconnect": {
      const socket = held.get(step.identity);
      // Not tolerated as a no-op: a scenario saying "this one goes away" has
      // nothing to say if nothing was being held, and the state it is arranging
      // would silently be the wrong one.
      if (!socket) fail(`${step.identity} holds no socket to disconnect`);
      socket.socket.close();
      held.delete(step.identity);
      return;
    }

    case "expectPushed": {
      const socket = held.get(step.identity);
      if (!socket) fail(`${step.identity} holds no socket, so nothing could have been pushed to it`);
      // Waits for the count it wants, then keeps watching for a moment. A bare
      // poll-until-reached passes the instant the number is hit and cannot see
      // an extra arriving right after -- and `count: 0`, which is what § 8.2a
      // actually asserts, would otherwise pass without waiting at all.
      const deadline = Date.now() + (step.count === 0 ? 3_000 : 15_000);
      while (Date.now() < deadline && socket.since() < step.count) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (step.count === 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
      const seen = socket.since();
      socket.clear();
      if (seen !== step.count) {
        fail(`expected ${step.count} push(es) since the last check, got ${seen}`);
      }
      return;
    }

    case "send": {
      const from = registry.get(step.from);
      if (!from) fail(`${step.from} was never provisioned in this run`);
      const got = await http(from, mesh.apiHttp, "POST", "/api/v1/mailbox/out", {
        to: step.to,
        content: step.content,
        ...(step.replyTo ? { reply_to: step.replyTo } : {}),
        ...(step.clientMessageId ? { client_message_id: step.clientMessageId } : {}),
      });
      assertRpc(step.expect, asRpcOutcome(got));
      return;
    }

    case "receive": {
      const identity = registry.get(step.identity);
      if (!identity) fail(`${step.identity} was never provisioned in this run`);
      // Acknowledgement and the next lease are one call, which is what makes
      // "settle the previous batch" atomic (§ 8.10.1).
      const got = await http(identity, mesh.apiHttp, "POST", "/api/v1/mailbox/in", {
        ...(step.ackPrevious ? { ack_ids: leases.get(step.identity) ?? [] } : {}),
      });
      if (got.status !== 200) fail(`receive returned HTTP ${got.status}: ${short(got.body)}`);
      const messages = Array.isArray(got.body?.messages) ? got.body.messages : [];
      leases.set(step.identity, messages.map((message: any) => String(message.id)));
      if (step.expectCount !== undefined && messages.length !== step.expectCount) {
        fail(`expected ${step.expectCount} message(s), got ${messages.length}: ${short(got.body)}`);
      }
      applyBind(step.bind, got.body, bindings);
      return;
    }

    case "http": {
      // `as` names an authority; the **path** names the service. The comment
      // here used to say the first half and the code did neither: the base came
      // from `as`, so `/api/v1/admin/...` could only be addressed by an operator
      // session. That made "what does this operator route answer someone with no
      // session" unstatable — the refusal half of every authorization pair, and
      // the only half a caller without credentials can observe.
      //
      // The hub's REST surface is small and enumerable -- `rest/*.ts` plus the
      // two routes in its `main.ts` -- so it is the closed set and everything
      // else belongs to the admin service. A prefix list of admin paths was
      // tried first and was wrong within the hour: `/api/v1/audit/events` is
      // served there too, and an unauthenticated call to it reached the hub and
      // got a 404 that read like a missing route.
      //
      // `/api/v1/agents` is on both. It stays with the hub, which is what
      // E2E-PROXY-001 addresses unauthenticated. A hub route added later and
      // not listed here goes to the admin service and 404s -- loud, and the
      // fix is one line.
      const HUB_PATHS = [
        "/api/v1/agents",
        "/api/v1/capabilities",
        "/api/v1/limits",
        "/api/v1/mailbox",
        "/api/v1/rpc",
      ];
      const adminService = !HUB_PATHS.some((prefix) => step.path.startsWith(prefix));
      const asAdmin = step.as === "admin";
      const signedBy = typeof step.as === "object" && step.as !== null ? step.as.signedBy : null;
      const signer = signedBy ? registry.get(signedBy) : null;
      if (signedBy && !signer) fail(`${signedBy} was never provisioned in this run`);
      const got = await http(
        signer ?? null,
        adminService || asAdmin ? mesh.baseUrl : mesh.apiHttp,
        step.method,
        step.path,
        step.body,
        asAdmin ? await adminCookie(mesh) : undefined,
      );
      assertHttp(step.expect, got);
      applyBind(step.bind, got.body, bindings);
      return;
    }

    case "sleep":
      await new Promise((resolve) => setTimeout(resolve, step.seconds * 1_000));
      return;

    default: {
      // Two guards for one rule, because they fail at different times.
      //
      // The `never` binding is the one that matters: a verb added to the
      // contract and not handled here stops `bun run check` before a mesh is
      // ever started, so the gap cannot reach a run. The throw is what remains
      // if the two ever disagree -- a step nobody ran must not read as one that
      // passed, which is the failure § 17.3 exists to forbid and the one the
      // platform's runner had while citing that clause.
      const unhandled: never = step;
      fail(`verb not implemented by this runner: ${(unhandled as { do: string }).do}`);
    }
  }
}

async function runScenario(
  mesh: Mesh,
  registry: Registry,
  bindings: Map<string, string>,
  scenario: Scenario,
): Promise<ScenarioResult> {
  const leases = new Map<string, string[]>();
  const held = new Map<string, Held>();
  const steps: StepResult[] = [];
  let failed = false;

  for (const [index, step] of scenario.steps.entries()) {
    if (failed) break;
    try {
      await runStep(mesh, registry, leases, bindings, held, step);
      steps.push({ step: index + 1, verb: step.do, outcome: "passed" });
    } catch (error) {
      steps.push({
        step: index + 1,
        verb: step.do,
        outcome: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      failed = true;
    }
  }

  // Hygiene, not an assertion: a socket left open changes presence for the
  // next scenario, and on the shared mesh that moves every delivered/pending
  // verdict after it. The scenario still has to say `disconnect` where the
  // absence is part of what it claims.
  for (const socket of held.values()) {
    try {
      socket.socket.close();
    } catch {
      // A socket the hub already closed is already in the state we want.
    }
  }

  return {
    id: scenario.id,
    clause: scenario.clause,
    outcome: failed ? "failed" : "passed",
    steps,
  };
}

alignPlatformCheckout();

const only = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
// Before anything is selected: two scenarios sharing an id would both be
// selected, both run and both report, so the tally that guards the count sees a
// perfect run. `--only` on that id would silently run two unrelated scenarios.
const duplicated = duplicateIds(E2E_SCENARIOS);
if (duplicated.length > 0) {
  process.stderr.write(`${duplicateIdMessage(duplicated, E2E_SCENARIOS.length)}\n`);
  process.exit(2);
}
const selected = only ? E2E_SCENARIOS.filter((s) => s.id === only) : E2E_SCENARIOS;
if (selected.length === 0) {
  process.stderr.write(`no scenario matches ${only}\n`);
  process.exit(2);
}

const results: ScenarioResult[] = [];
const provenances = new Set<string>();

// The shared mesh, in order. One registry, because the scenarios reference each
// other's identities on purpose.
const shared = selected.filter((scenario) => !scenario.mesh);
if (shared.length > 0) {
  const mesh = await startMesh(undefined);
  provenances.add(mesh.provenance);
  process.stdout.write(`[runner] mesh for ${shared.length} shared scenario(s) — platform ${mesh.provenance}\n`);
  const registry: Registry = new Map();
  try {
    // Bindings live with the identities they name: `fingerprint:<identity>` is
    // derived from a key the registry holds, so the two must not outlive each
    // other. `bind` names are cleared per scenario so a stale value cannot be
    // silently reused by a scenario that forgot to capture its own.
    const bindings = new Map<string, string>();
    for (const scenario of shared) {
      for (const name of [...bindings.keys()]) {
        if (!name.startsWith("fingerprint:")) bindings.delete(name);
      }
      results.push(await runScenario(mesh, registry, bindings, scenario));
    }
  } finally {
    mesh.stop();
  }
}

// And one mesh each for the scenarios whose shape is part of their claim.
// One *each*, even where two ask for the same shape: § 17.4 says a scenario
// carrying `mesh` gets its own and must provision everything it names, so
// sharing would let one of them pass on state the other left behind.
for (const scenario of selected.filter((s) => s.mesh)) {
  const mesh = await startMesh(scenario.mesh);
  provenances.add(mesh.provenance);
  process.stdout.write(
    `[runner] mesh ${JSON.stringify(scenario.mesh)} for ${scenario.id} — platform ${mesh.provenance}\n`,
  );
  try {
    results.push(await runScenario(mesh, new Map(), new Map(), scenario));
  } finally {
    mesh.stop();
  }
}

process.stdout.write("\n");
for (const result of results) {
  const mark = result.outcome === "passed" ? "ok" : "FAIL";
  process.stdout.write(`${mark.padEnd(8)} ${result.id.padEnd(18)} ${result.clause}\n`);
  for (const step of result.steps) {
    if (step.outcome === "passed") continue;
    process.stdout.write(`         step ${step.step} ${step.verb}: ${step.outcome} — ${step.detail}\n`);
  }
}

// Printed with the totals, not only in the header. A result that cannot say
// what answered is not a finding anybody can act on -- reporting one without
// this cost both sides half an hour on a refusal that had shipped long before.
process.stdout.write(`\nplatform: ${[...provenances].join(", ") || "unknown"}\n`);

const failedCount = results.filter((r) => r.outcome === "failed").length;
// The denominator is what ran, so a filtered run says so rather than letting
// `1/1 contract scenarios` read as the whole set having passed. The count comes
// from the contract, not from a number written here: the platform side reported
// a scenario total twice from a `bun test` case count instead, and an agreement
// to be careful did not stop the second one.
process.stdout.write(
  `\n${results.length - failedCount}/${selected.length} contract scenarios` +
    (only ? ` — filtered to ${only}, of ${E2E_SCENARIOS.length} in the contract` : "") +
    "\n",
);
const mismatch = tallyMismatch(selected.length, results.length);
if (mismatch) {
  process.stderr.write(`${mismatch}\n`);
  process.exit(2);
}
process.exit(failedCount === 0 ? 0 : 1);
