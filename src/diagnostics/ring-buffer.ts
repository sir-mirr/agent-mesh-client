/**
 * The last hour of what this client did, kept in memory for a bundle to carry.
 *
 * The client runs on someone else's machine. When they report that a message
 * did not arrive, the operator cannot reproduce it and cannot ask the process
 * anything -- by the time the complaint is written the process has usually been
 * restarted. So the client keeps its own recent history and hands it over on
 * request, and the design question is what "recent" means when nobody can
 * intervene to decide.
 *
 * Two bounds, whichever binds first (PM, `LOGGING-OPS.md` §1, 2026-08-21):
 *
 *   60 minutes   older than that has stopped being about the complaint
 *   5 MB         the bundle is an email attachment, so bytes are the operating
 *                constraint. A line count is not: one stack trace is worth a
 *                thousand `connected` lines, and a bound in lines lets the
 *                information content of a full buffer swing by orders of
 *                magnitude while the number stays reassuringly the same.
 *
 * Rotation drops oldest-first, which is the only order that keeps the newest
 * events -- the ones the complaint is actually about -- when both bounds are hit
 * at once.
 *
 * **A dropped record is counted, not forgotten.** `dropped` survives rotation
 * and rides along in the snapshot, because a buffer that silently discards its
 * beginning reads exactly like a buffer whose beginning was quiet, and those
 * are opposite facts. This is the same rule the bundle applies to itself: an
 * absence must say it is an absence (`LOGGING-OPS.md` §0 ③).
 */

import { redactText, redactValue } from "./redact";

export type DiagnosticLevel = "error" | "warn" | "info";

export interface DiagnosticRecord {
  /** ISO-8601 UTC. The bundle is read in a timezone nobody can predict. */
  at: string;
  level: DiagnosticLevel;
  /** Which part of the client spoke: `hub`, `outbox`, `lane`, `cli`. */
  component: string;
  message: string;
  /**
   * The correlation key this record belongs to -- a message id (`aud_…`), an
   * rpc id (`rpc_…`) or a local op-id. `null` for records that belong to no
   * single operation, which is honest rather than tidy: inventing an id for a
   * startup line would make it look pairable with a server log that never
   * mentions it.
   */
  correlationId: string | null;
  /** Masked on the way in, so a secret is never resident in the buffer. */
  fields: Record<string, unknown>;
}

export interface RingBufferSnapshot {
  records: readonly DiagnosticRecord[];
  /** How many records rotation discarded over the buffer's whole life. */
  dropped: number;
  bytes: number;
  window_seconds: number;
  max_bytes: number;
}

export const RING_WINDOW_SECONDS = 60 * 60;
export const RING_MAX_BYTES = 5 * 1024 * 1024;

export class DiagnosticRing {
  readonly #records: DiagnosticRecord[] = [];
  readonly #sizes: number[] = [];
  #bytes = 0;
  #dropped = 0;

  constructor(
    readonly windowSeconds: number = RING_WINDOW_SECONDS,
    readonly maxBytes: number = RING_MAX_BYTES,
  ) {}

  /**
   * Injectable clock for the same reason `LoopMeter.snapshot` takes one: a test
   * that cannot move time can only assert that two numbers came back, not that
   * the older of two records was the one that went.
   */
  record(
    entry: {
      level: DiagnosticLevel;
      component: string;
      message: string;
      correlationId?: string | null;
      fields?: Record<string, unknown>;
    },
    nowMs: number = Date.now(),
  ): void {
    const record: DiagnosticRecord = {
      at: new Date(nowMs).toISOString(),
      level: entry.level,
      component: entry.component,
      message: redactText(entry.message),
      correlationId: entry.correlationId ?? null,
      fields: (redactValue(entry.fields ?? {}) as Record<string, unknown>) ?? {},
    };
    const size = Buffer.byteLength(JSON.stringify(record), "utf8");
    this.#records.push(record);
    this.#sizes.push(size);
    this.#bytes += size;
    this.#rotate(nowMs);
  }

  /**
   * Drop oldest-first until both bounds hold.
   *
   * Age is evaluated here rather than only at snapshot time so that a process
   * sitting idle for a day is not holding a day-old record in memory waiting
   * for someone to ask.
   */
  #rotate(nowMs: number): void {
    const oldestAllowedMs = nowMs - this.windowSeconds * 1000;
    while (this.#records.length > 0) {
      const oldest = this.#records[0]!;
      const tooOld = Date.parse(oldest.at) < oldestAllowedMs;
      const tooBig = this.#bytes > this.maxBytes;
      if (!tooOld && !tooBig) break;
      this.#records.shift();
      this.#bytes -= this.#sizes.shift()!;
      this.#dropped += 1;
    }
  }

  snapshot(nowMs: number = Date.now()): RingBufferSnapshot {
    this.#rotate(nowMs);
    return {
      records: [...this.#records],
      dropped: this.#dropped,
      bytes: this.#bytes,
      window_seconds: this.windowSeconds,
      max_bytes: this.maxBytes,
    };
  }

  clear(): void {
    this.#records.length = 0;
    this.#sizes.length = 0;
    this.#bytes = 0;
    this.#dropped = 0;
  }
}

/**
 * One per process, for the reason `loopMeter` is: the things that emit
 * diagnostics are spread across the daemon, the lane server and the CLI, and
 * threading a buffer through every constructor that already takes an
 * `onDiagnostic` callback would be a larger change than the buffer itself.
 */
export const diagnosticRing = new DiagnosticRing();

/**
 * Adapt the existing `onDiagnostic(message, error?)` callback to the ring.
 *
 * Every component already accepts that callback and every one of them defaults
 * it to a no-op, which is where diagnostics have been going until now. Wrapping
 * rather than replacing keeps the existing stderr sink working: the CLI still
 * prints, and the ring also keeps.
 */
export function ringDiagnostic(
  component: string,
  next?: (message: string, error?: unknown) => void,
): (message: string, error?: unknown) => void {
  return (message, error) => {
    diagnosticRing.record({
      level: error === undefined ? "info" : "error",
      component,
      message,
      fields: error === undefined ? {} : { error: describeError(error) },
    });
    next?.(message, error);
  };
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
