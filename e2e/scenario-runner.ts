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

/**
 * The platform checkout whose harness this run drives.
 *
 * `-main` is not decoration. The sibling directory without it is a feature
 * worktree, and a run against it once produced a confident bug report about a
 * refusal that had shipped forty commits earlier -- the mesh was fine and the
 * tree was old. Which tree answered is part of the result, which is why the
 * report prints the revision the ready file declares.
 */
const PLATFORM =
  process.env.AGENT_MESH_E2E_PLATFORM ??
  join(import.meta.dir, "..", "..", "agent-mesh-platform-main");

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
  return {
    provenance: `${platform.branch ?? "?"} ${platform.commit ?? "unknown"}${
      platform.dirty === "true" || platform.dirty === true ? " (dirty)" : ""
    }`,
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
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A non-JSON body is still evidence; the assertion decides whether it matters.
  }
  return { status: response.status, body: parsed };
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
): Promise<RpcOutcome> {
  const socket = new WebSocket(mesh.rpcWs);
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
    return await answer;
  } finally {
    try {
      socket.close();
    } catch {
      // Closing a socket that never opened is not a scenario outcome.
    }
  }
}

async function adminCookie(mesh: Mesh): Promise<string> {
  const response = await fetch(mesh.loginUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: mesh.loginBody,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const token = response.headers.get("set-cookie")?.match(/mesh_token=([^;]+)/)?.[1];
  if (!token) fail(`admin login did not return a session (HTTP ${response.status})`);
  return `mesh_token=${token}`;
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
    // Absent is reported as absent rather than as a mismatch against
    // `undefined`: a renamed field and a wrong value are different defects.
    if (!found) fail(`expected ${path} = ${JSON.stringify(wanted)}, but the body has no ${path}: ${short(got.body)}`);
    if (value !== wanted) {
      fail(`expected ${path} = ${JSON.stringify(wanted)}, got ${JSON.stringify(value)}`);
    }
  }
}

function assertRpc(expect: { error?: number | null; dataCode?: string } | undefined, got: RpcOutcome): void {
  if (!expect) return;
  if (expect.error === null) {
    if (got.error) fail(`expected success, got error ${short(got.error)}`);
  } else if (expect.error !== undefined) {
    if (got.error?.code !== expect.error) fail(`expected error ${expect.error}, got ${short(got.error ?? got.result)}`);
  }
  if (expect.dataCode !== undefined && got.error?.data?.code !== expect.dataCode) {
    fail(`expected data.code ${expect.dataCode}, got ${short(got.error)}`);
  }
}

/** The signed REST surfaces answer JSON-RPC errors in an HTTP envelope. */
function asRpcOutcome(got: HttpOutcome): RpcOutcome {
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
  raw: Step,
): Promise<void> {
  // Resolved once, here, for every verb. The contract names `path`, `body` and
  // `expect.body` as the substitutable places; doing it per-verb is how a step
  // ends up quietly unsubstituted while still reporting green.
  //
  // Read through a loose view rather than typing `step` loosely. An earlier
  // draft made the whole step `Step & Record<string, any>`, which silently
  // defeated the exhaustiveness check below -- deleting a verb's case still
  // typechecked, so the guard against an unhandled verb was decoration.
  const loose = raw as { path?: string; body?: unknown; expect?: ExpectHttp };
  const step: Step = {
    ...raw,
    ...(loose.path !== undefined ? { path: substitute(loose.path, bindings) } : {}),
    ...(loose.body !== undefined ? { body: substitute(loose.body, bindings) } : {}),
    ...(loose.expect?.body !== undefined
      ? { expect: { ...loose.expect, body: substitute(loose.expect.body, bindings) } }
      : {}),
  } as Step;

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
      const identity = registry.get(step.identity);
      if (!identity) fail(`${step.identity} was never provisioned in this run`);
      assertRpc(step.expect, await rpc(mesh, identity, "mesh.connect", { identity: step.identity }));
      return;
    }

    case "send": {
      const from = registry.get(step.from);
      if (!from) fail(`${step.from} was never provisioned in this run`);
      const got = await http(from, mesh.apiHttp, "POST", "/api/v1/outbox", {
        to: step.to,
        content: step.content,
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
      const got = await http(identity, mesh.apiHttp, "POST", "/api/v1/inbox", {
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
      // `as` names an authority, not a base URL: the operator session belongs to
      // the admin service, and both `none` and a signed participant address the
      // hub. A signed caller needs an identity this run generated, since the
      // signature is over a key no scenario can carry.
      const admin = step.as === "admin";
      const signedBy = typeof step.as === "object" && step.as !== null ? step.as.signedBy : null;
      const signer = signedBy ? registry.get(signedBy) : null;
      if (signedBy && !signer) fail(`${signedBy} was never provisioned in this run`);
      const got = await http(
        signer ?? null,
        admin ? mesh.baseUrl : mesh.apiHttp,
        step.method,
        step.path,
        step.body,
        admin ? await adminCookie(mesh) : undefined,
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
  const steps: StepResult[] = [];
  let failed = false;

  for (const [index, step] of scenario.steps.entries()) {
    if (failed) break;
    try {
      await runStep(mesh, registry, leases, bindings, step);
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

  return {
    id: scenario.id,
    clause: scenario.clause,
    outcome: failed ? "failed" : "passed",
    steps,
  };
}

const only = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
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
process.stdout.write(`\n${results.length - failedCount}/${results.length} contract scenarios\n`);
process.exit(failedCount === 0 ? 0 : 1);
