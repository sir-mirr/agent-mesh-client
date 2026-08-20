import { describe, expect, test } from "bun:test";
import { LoopMeter } from "../src/daemon/loop-meter";
import { codeOnly } from "./support/code-only";

describe("loop meter", () => {
  test("passes are counted per loop and reported sorted", () => {
    const meter = new LoopMeter(0, { user: 0, system: 0 });
    for (let i = 0; i < 7; i += 1) meter.countPass("hub-watch");
    for (let i = 0; i < 3; i += 1) meter.countPass("audit");
    const snapshot = meter.snapshot(1_000, { user: 0, system: 0 });
    expect(snapshot.passes).toEqual({ audit: 3, "hub-watch": 7 });
    expect(Object.keys(snapshot.passes)).toEqual(["audit", "hub-watch"]);
  });

  // The arithmetic is the point of the field. A status that reports two raw
  // counters and leaves the division to the reader answers nothing that `ps`
  // did not already answer.
  test("cpu is divided by uptime, and by passes", () => {
    const meter = new LoopMeter(0, { user: 1_000, system: 500 });
    for (let i = 0; i < 100; i += 1) meter.countPass("audit");
    // 10s of wall, 200ms user + 100ms system on top of the baseline.
    const snapshot = meter.snapshot(10_000, { user: 201_000, system: 100_500 });
    expect(snapshot.uptime_seconds).toBe(10);
    expect(snapshot.cpu_user_ms).toBe(200);
    expect(snapshot.cpu_system_ms).toBe(100);
    // 300ms of CPU in 10s of wall = 3% of one core.
    expect(snapshot.cpu_percent_of_core).toBe(3);
    // 300_000us over 100 passes.
    expect(snapshot.cpu_microseconds_per_pass).toBe(3_000);
  });

  // The baseline subtraction: a daemon that has been up for a day has a large
  // absolute cpuUsage, and a meter reset at reload must not attribute it.
  test("cpu is measured from the meter's own baseline", () => {
    const meter = new LoopMeter(0, { user: 60_000_000, system: 5_000_000 });
    meter.countPass("audit");
    const snapshot = meter.snapshot(1_000, { user: 60_500_000, system: 5_000_000 });
    expect(snapshot.cpu_user_ms).toBe(500);
  });

  // Without this a fresh daemon reports 0 microseconds per pass, which reads as
  // "the loops are free" when it means "the loops have not run".
  test("no passes yet reports null rather than zero", () => {
    const meter = new LoopMeter(0, { user: 0, system: 0 });
    const snapshot = meter.snapshot(5_000, { user: 40_000, system: 0 });
    expect(snapshot.cpu_microseconds_per_pass).toBeNull();
    expect(snapshot.passes).toEqual({});
    // The percentage still works -- it does not divide by passes.
    expect(snapshot.cpu_percent_of_core).toBe(0.8);
  });

  test("a snapshot taken at the same instant does not divide by zero", () => {
    const meter = new LoopMeter(1_000, { user: 0, system: 0 });
    expect(meter.snapshot(1_000, { user: 0, system: 0 }).cpu_percent_of_core).toBe(0);
  });

  test("reset moves the baseline forward", () => {
    const meter = new LoopMeter(0, { user: 0, system: 0 });
    meter.countPass("audit");
    meter.reset(10_000, { user: 1_000_000, system: 0 });
    const snapshot = meter.snapshot(20_000, { user: 1_500_000, system: 0 });
    expect(snapshot.passes).toEqual({});
    expect(snapshot.cpu_user_ms).toBe(500);
    expect(snapshot.uptime_seconds).toBe(10);
  });

  // A meter nothing calls reports zeroes forever, and zeroes are exactly what a
  // healthy idle daemon looks like. Each of the three one-second loops has to
  // be counted at its own site.
  test("all three one-second loops count their passes", async () => {
    const sites: Array<[string, string]> = [
      ["src/daemon/agent-mesh-daemon.ts", 'loopMeter.countPass("delivery")'],
      ["src/hub/audit-worker.ts", 'loopMeter.countPass("audit")'],
      ["src/hub/lane-hub-connection.ts", 'loopMeter.countPass("hub-watch")'],
    ];
    for (const [path, call] of sites) {
      expect(codeOnly(await Bun.file(path).text(), "slash")).toContain(call);
    }
  });

  test("the daemon status carries the meter", async () => {
    const source = codeOnly(await Bun.file("src/daemon/host-daemon.ts").text(), "slash");
    expect(source).toContain("loops: loopMeter.snapshot()");
  });
});
