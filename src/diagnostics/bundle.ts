/**
 * One command, one file, and the operator can name the failing layer.
 *
 * The premise (PM, `LOGGING-OPS.md`, 2026-08-21): the client runs outside our
 * reach, so a complaint cannot be reproduced. Everything the diagnosis needs
 * has to be collectable in one shot, by a user who is already annoyed, without
 * a second round trip.
 *
 * Which makes the *failure* modes of collection the interesting part, not the
 * happy path. A collector that cannot reach the daemon has three honest
 * answers -- the daemon is not running, the socket refused us, we timed out --
 * and one dishonest one, which is an empty section. An empty section is read as
 * "nothing was wrong there", so a bundle that collapses them has quietly moved
 * the diagnosis away from the real fault. Every section therefore carries its
 * own outcome:
 *
 *   read          it is here, and it is what it says
 *   absent        we looked; the thing does not exist (no config file yet)
 *   unreadable    it exists and we could not have it, with the reason
 *   unavailable   it is live state and the source did not answer, with why
 *
 * That is the same four-way count this repository applies to reads elsewhere,
 * turned on the collector itself: `complete: false` alone would be one more
 * folded cell, since "the daemon is stopped" and "the daemon refused us" send
 * an operator to different places.
 *
 * **The contract tag is read from the pin, never from the installed package.**
 * `node_modules/@agent-mesh/contracts/package.json` says `0.23.0` while the
 * pinned tag is `v0.29.0` -- six tags apart, measured 2026-08-21. A bundle that
 * read the version field would report the wrong contract to every complaint,
 * and would do it with the confidence of a value that came from the package
 * itself. `test/bundle-contract-pin.test.ts` and a mutation anchor hold this.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import packageManifest from "../../package.json";
import { probeHostDaemon, requestControl } from "../daemon/host-daemon";
import { diagnosticRing, describeError, type RingBufferSnapshot } from "./ring-buffer";
import { redactValue } from "./redact";

export type SectionOutcome = "read" | "absent" | "unreadable" | "unavailable";

export interface BundleSection<T> {
  outcome: SectionOutcome;
  /** Present when `outcome` is `read`; `null` otherwise -- never `{}`. */
  value: T | null;
  /** Why, for every outcome except `read`. Never a bare "failed". */
  reason: string | null;
}

export interface DiagnosticBundle {
  schema_version: number;
  generated_at: string;
  client_version: string;
  /** The pinned tag, e.g. `v0.29.0`, or a section saying why we cannot say. */
  contract_pin: BundleSection<string>;
  platform: BundleSection<{ os: string; arch: string; runtime: string; runtime_version: string }>;
  daemon: BundleSection<unknown>;
  hub: BundleSection<unknown>;
  outbox: BundleSection<unknown>;
  config: BundleSection<unknown>;
  recent_errors: BundleSection<unknown>;
  ring: BundleSection<RingBufferSnapshot>;
  /**
   * True only when every section above says `read`. It is a convenience for a
   * human skimming the top of the file, not the source of truth -- the sections
   * are, and a reader who trusts this flag alone loses the reason.
   */
  complete: boolean;
  incomplete_sections: string[];
}

export const BUNDLE_SCHEMA_VERSION = 1;

function read<T>(value: T): BundleSection<T> {
  return { outcome: "read", value, reason: null };
}

function absent(reason: string): BundleSection<never> {
  return { outcome: "absent", value: null, reason };
}

function unreadable(reason: string): BundleSection<never> {
  return { outcome: "unreadable", value: null, reason };
}

function unavailable(reason: string): BundleSection<never> {
  return { outcome: "unavailable", value: null, reason };
}

/**
 * Distinguish "not there" from "there and refused".
 *
 * `ENOENT` is `absent`; anything else -- a permission bit, a directory where a
 * file should be -- is `unreadable` and keeps its code. Collapsing the two
 * would tell a user to create a config file they already have.
 */
function fileFailure(error: unknown): BundleSection<never> {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return absent("no such file");
  return unreadable(code ? `${code}: ${describeError(error)}` : describeError(error));
}

/**
 * The pinned contract tag, from `package.json`'s dependency spec.
 *
 * Deliberately not `import("@agent-mesh/contracts/package.json").version`. See
 * the header: those two disagree by six tags today.
 */
export function contractPin(
  manifest: { dependencies?: Record<string, string> } = packageManifest,
): BundleSection<string> {
  const spec = manifest.dependencies?.["@agent-mesh/contracts"];
  if (spec === undefined) return absent("@agent-mesh/contracts is not a dependency");
  const match = /#(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(spec);
  if (!match) return unreadable(`dependency spec names no tag: ${spec}`);
  return read(match[1]!);
}

function platformSection(): BundleSection<{
  os: string;
  arch: string;
  runtime: string;
  runtime_version: string;
}> {
  return read({
    os: `${process.platform} ${process.arch}`,
    arch: process.arch,
    runtime: typeof Bun === "undefined" ? "node" : "bun",
    runtime_version: typeof Bun === "undefined" ? process.version : Bun.version,
  });
}

/**
 * Ask the running daemon something, and say which way it failed.
 *
 * `probeHostDaemon` returning null is a *stopped daemon*, which is a finding
 * and not an error -- half the complaints this bundle exists for are "nothing
 * happens", and a stopped daemon is the answer to those. It must not read the
 * same as a control socket that hung up.
 */
async function control(runtimeDirectory: string, method: string): Promise<BundleSection<unknown>> {
  try {
    const status = await probeHostDaemon(runtimeDirectory);
    if (status === null) return unavailable("daemon is not running");
    const value = await requestControl(runtimeDirectory, method, {});
    return read(redactValue(value));
  } catch (error) {
    return unavailable(`${method}: ${describeError(error)}`);
  }
}

export interface BundleInputs {
  configFile: string;
  stateDirectory: string;
  runtimeDirectory: string;
  now?: number;
}

export async function collectBundle(inputs: BundleInputs): Promise<DiagnosticBundle> {
  const nowMs = inputs.now ?? Date.now();

  const [daemon, hub, outbox] = await Promise.all([
    control(inputs.runtimeDirectory, "daemon.status"),
    control(inputs.runtimeDirectory, "hub.status"),
    control(inputs.runtimeDirectory, "outbox.summary"),
  ]);

  let config: BundleSection<unknown>;
  try {
    const text = await readFile(inputs.configFile, "utf8");
    // Kept as text, masked as text. Parsing it here would mean a config the
    // client itself cannot parse -- a real and diagnosable fault -- turning
    // into an `unreadable` section that hides the malformed line.
    config = read({ path: inputs.configFile, text: redactValue(text) });
  } catch (error) {
    config = fileFailure(error);
  }

  const ring = diagnosticRing.snapshot(nowMs);
  const errors = ring.records.filter((record) => record.level === "error");

  const bundle: DiagnosticBundle = {
    schema_version: BUNDLE_SCHEMA_VERSION,
    generated_at: new Date(nowMs).toISOString(),
    client_version: packageManifest.version,
    contract_pin: contractPin(),
    platform: platformSection(),
    daemon,
    hub,
    outbox,
    config,
    recent_errors: read(errors),
    ring: read(ring),
    complete: true,
    incomplete_sections: [],
  };

  const sections: Array<[string, BundleSection<unknown>]> = [
    ["contract_pin", bundle.contract_pin],
    ["platform", bundle.platform],
    ["daemon", bundle.daemon],
    ["hub", bundle.hub],
    ["outbox", bundle.outbox],
    ["config", bundle.config],
    ["recent_errors", bundle.recent_errors],
    ["ring", bundle.ring],
  ];
  bundle.incomplete_sections = sections
    .filter(([, section]) => section.outcome !== "read")
    .map(([name]) => name);
  bundle.complete = bundle.incomplete_sections.length === 0;
  return bundle;
}

/**
 * Where a bundle lands when the user does not name a path.
 *
 * Under the state directory beside the daemon's logs, because that directory
 * already exists, is already the client's own, and is where an operator walking
 * a user through the complaint will already be looking.
 */
export function bundlePath(stateDirectory: string, nowMs: number = Date.now()): string {
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
  return join(stateDirectory, "diagnostics", `bundle-${stamp}.json`);
}

/** Exported for the test that asserts the daemon log tail is not silently skipped. */
export async function fileSection(path: string): Promise<BundleSection<{ path: string; bytes: number }>> {
  try {
    const info = await stat(path);
    return read({ path, bytes: info.size });
  } catch (error) {
    return fileFailure(error);
  }
}
