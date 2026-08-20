/**
 * What the daemon spends on its own timers, reported by the daemon.
 *
 * A lane costs a steady fraction of a core with an empty outbox, an idle hub
 * connection and zero rows in every table, and over four hours of sampling that
 * fraction rose at +0.136 percentage points per hour (t = 4.3, so not noise).
 * Naming the cause from outside failed at every instrument available:
 *
 *   `ps`        gives one number for the whole process, no breakdown
 *   `sample`    the shipped binary is stripped, so every frame reads `???`
 *   `nettop`    cannot see loopback, and the hub is on 127.0.0.1
 *   `lsof`      counts handles, and nothing was leaking handles
 *
 * The daemon runs three one-second loops per lane and is the only thing in a
 * position to say which of them is getting more expensive. So it counts its own
 * passes and reads its own CPU, and `daemon status` answers with both. The
 * interesting quantity is microseconds per pass: a rising *rate* with a flat
 * cost per pass means something is scheduling more often, and a flat rate with
 * a rising cost per pass means a pass is doing more work than it used to. Those
 * two have different causes and no external tool can tell them apart.
 *
 * Cost of the meter itself: one integer increment per pass. Deliberately not a
 * timer around each loop -- `__gettimeofday` was already the single hottest
 * frame in a 30-second profile of this daemon, and an instrument that is the
 * thing it measures is not an instrument.
 */

export interface LoopMeterSnapshot {
  uptime_seconds: number;
  cpu_user_ms: number;
  cpu_system_ms: number;
  /** Average over the whole uptime, not an instantaneous reading. */
  cpu_percent_of_core: number;
  passes: Record<string, number>;
  /**
   * `null` rather than zero when nothing has run. A zero here reads as "the
   * loops are free", which is the opposite of "the loops have not run yet".
   */
  cpu_microseconds_per_pass: number | null;
}

export interface CpuUsage {
  user: number;
  system: number;
}

export class LoopMeter {
  readonly #counts = new Map<string, number>();
  #startedAtMs: number;
  #startCpu: CpuUsage;

  constructor(startedAtMs: number = Date.now(), startCpu: CpuUsage = process.cpuUsage()) {
    this.#startedAtMs = startedAtMs;
    this.#startCpu = startCpu;
  }

  countPass(loop: string): void {
    this.#counts.set(loop, (this.#counts.get(loop) ?? 0) + 1);
  }

  /**
   * Injectable clock and usage so a test can assert the arithmetic rather than
   * assert that two numbers came back.
   */
  snapshot(nowMs: number = Date.now(), cpu: CpuUsage = process.cpuUsage()): LoopMeterSnapshot {
    const uptimeSeconds = Math.max(0, (nowMs - this.#startedAtMs) / 1000);
    const userMicroseconds = cpu.user - this.#startCpu.user;
    const systemMicroseconds = cpu.system - this.#startCpu.system;
    const totalMicroseconds = userMicroseconds + systemMicroseconds;
    const passes = Object.fromEntries([...this.#counts].sort(([a], [b]) => a.localeCompare(b)));
    const totalPasses = [...this.#counts.values()].reduce((sum, count) => sum + count, 0);
    return {
      uptime_seconds: Number(uptimeSeconds.toFixed(1)),
      cpu_user_ms: Number((userMicroseconds / 1000).toFixed(1)),
      cpu_system_ms: Number((systemMicroseconds / 1000).toFixed(1)),
      cpu_percent_of_core:
        uptimeSeconds > 0 ? Number((totalMicroseconds / (uptimeSeconds * 1_000_000) * 100).toFixed(3)) : 0,
      passes,
      cpu_microseconds_per_pass:
        totalPasses > 0 ? Number((totalMicroseconds / totalPasses).toFixed(1)) : null,
    };
  }

  reset(startedAtMs: number = Date.now(), startCpu: CpuUsage = process.cpuUsage()): void {
    this.#counts.clear();
    this.#startedAtMs = startedAtMs;
    this.#startCpu = startCpu;
  }
}

/**
 * One per process, because the loops being counted are process-wide and
 * threading a meter through three constructors to reach them would be a larger
 * change than the thing it measures.
 */
export const loopMeter = new LoopMeter();
