import { describe, expect, test } from "bun:test";
import { DiagnosticRing, RING_MAX_BYTES, RING_WINDOW_SECONDS } from "../src/diagnostics/ring-buffer";

/**
 * The buffer a complaint is answered from, and what it admits it lost.
 *
 * The bound is 60 minutes *and* 5 MB, whichever binds first (`LOGGING-OPS.md`
 * §1). Both halves are asserted here with a moved clock rather than a real one,
 * because a test that cannot move time can only check that records came back --
 * not that the *older* of two was the one rotation chose.
 *
 * The `dropped` counter gets its own test for the reason the counter exists at
 * all: a buffer that discards its beginning silently reads exactly like a
 * buffer whose beginning was quiet. This repository has paid for that shape
 * twice — an empty list standing in for an unanswered read, and a `0` standing
 * in for "could not measure" — and a ring buffer is the third place it can
 * happen.
 */
describe("diagnostic ring", () => {
  test("records outside the sixty-minute window are dropped oldest-first and counted", () => {
    const ring = new DiagnosticRing();
    const start = Date.parse("2026-08-21T00:00:00.000Z");

    ring.record({ level: "info", component: "hub", message: "first" }, start);
    ring.record({ level: "info", component: "hub", message: "second" }, start + 30 * 60_000);
    // 61 minutes after the first, so the first is outside the window and the
    // second (31 minutes old) is not.
    const later = start + 61 * 60_000;
    ring.record({ level: "info", component: "hub", message: "third" }, later);

    const snapshot = ring.snapshot(later);
    expect(snapshot.records.map((record) => record.message)).toEqual(["second", "third"]);
    expect(snapshot.dropped).toBe(1);
    expect(snapshot.window_seconds).toBe(RING_WINDOW_SECONDS);
  });

  test("the byte bound rotates before the age bound when it binds first", () => {
    // 500 bytes holds two of these records (213 each, measured) and not
    // three, so the third evicts the first while all three are seconds old.
    const ring = new DiagnosticRing(RING_WINDOW_SECONDS, 500);
    const start = Date.parse("2026-08-21T00:00:00.000Z");
    // Spaced so the padding is not itself one opaque run: a 100-character token
    // is exactly what the shape masker exists to redact.
    const padding = "x ".repeat(50);

    ring.record({ level: "info", component: "hub", message: `a${padding}` }, start);
    ring.record({ level: "info", component: "hub", message: `b${padding}` }, start + 1_000);
    ring.record({ level: "info", component: "hub", message: `c${padding}` }, start + 2_000);

    const snapshot = ring.snapshot(start + 2_000);
    expect(snapshot.bytes).toBeLessThanOrEqual(500);
    expect(snapshot.records.map((record) => record.message[0])).toEqual(["b", "c"]);
    expect(snapshot.dropped).toBe(1);
    expect(snapshot.max_bytes).toBe(500);
  });

  test("an empty buffer reports zero dropped rather than nothing at all", () => {
    const snapshot = new DiagnosticRing().snapshot(Date.parse("2026-08-21T00:00:00.000Z"));
    expect(snapshot.records).toEqual([]);
    expect(snapshot.dropped).toBe(0);
    expect(snapshot.max_bytes).toBe(RING_MAX_BYTES);
  });

  test("a secret handed to the ring is masked before it is stored", () => {
    const ring = new DiagnosticRing();
    const token = "Nzk2MDgxMjM0NTY3ODkwYWJjZGVmZ2hpamtsbW5vcA";
    ring.record(
      {
        level: "error",
        component: "channel",
        message: `gateway rejected ${token}`,
        fields: { token, lane_id: "lane-a" },
      },
      Date.parse("2026-08-21T00:00:00.000Z"),
    );

    const [record] = ring.snapshot(Date.parse("2026-08-21T00:00:00.000Z")).records;
    // Masked in the message by shape and in the field by name. Neither pass
    // alone covers both: the field name says nothing about the free text, and
    // the shape pass would miss a short token.
    expect(record!.message).not.toContain(token);
    expect(record!.fields.token).not.toBe(token);
    expect(record!.fields.lane_id).toBe("lane-a");
  });
});
