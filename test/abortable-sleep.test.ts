import { describe, expect, test } from "bun:test";
import { abortableSleep, type AbortLike } from "../src/util/abortable-sleep";
import { codeOnly } from "./support/code-only";

/**
 * A signal that remembers. A real `AbortSignal` cannot be asked how many
 * listeners it holds, which is exactly why a listener leak on one survived in
 * this repository until something went looking for a CPU ramp.
 */
function countingSignal(): AbortLike & { added: number; removed: number; outstanding: number; fire: () => void } {
  const listeners = new Set<() => void>();
  return {
    aborted: false,
    added: 0,
    removed: 0,
    get outstanding() {
      return listeners.size;
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
      this.added += 1;
    },
    removeEventListener(_type, listener) {
      if (listeners.delete(listener)) this.removed += 1;
    },
    fire() {
      for (const listener of [...listeners]) {
        listeners.delete(listener);
        listener();
      }
    },
  };
}

describe("abortableSleep", () => {
  // The leak itself: the timeout path is the one that ran once a second for the
  // life of a lane, and the one that registered without releasing.
  test("the timer winning releases the abort listener, every pass", async () => {
    const signal = countingSignal();
    for (let i = 0; i < 50; i += 1) await abortableSleep(0, signal);
    expect(signal.added).toBe(50);
    expect(signal.removed).toBe(50);
    expect(signal.outstanding).toBe(0);
  });

  // Without this the check above passes for a function that registers nothing
  // at all -- 0 added and 0 removed balance perfectly, and an abort would then
  // never interrupt a sleep.
  test("and the listener is really there while the sleep is running", async () => {
    const signal = countingSignal();
    const sleeping = abortableSleep(60_000, signal);
    expect(signal.outstanding).toBe(1);
    signal.fire();
    await sleeping;
    expect(signal.outstanding).toBe(0);
  });

  // A 60s sleep that only ends on its timer would hold a lane's shutdown open
  // for a minute. This is the reason the listener exists at all.
  test("an abort ends a long sleep rather than waiting it out", async () => {
    const signal = countingSignal();
    const started = performance.now();
    const sleeping = abortableSleep(60_000, signal);
    signal.fire();
    await sleeping;
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("a signal already aborted does not sleep and registers nothing", async () => {
    const signal = { ...countingSignal(), aborted: true };
    await abortableSleep(60_000, signal);
    expect(signal.added).toBe(0);
  });

  // `poke()` on the audit worker is this path: work arrived, stop waiting.
  test("the wake ends the sleep early and is handed back as null afterwards", async () => {
    const signal = countingSignal();
    const wakes: ((() => void) | null)[] = [];
    const sleeping = abortableSleep(60_000, signal, (wake) => wakes.push(wake));
    expect(typeof wakes[0]).toBe("function");
    wakes[0]!();
    await sleeping;
    // Null last: a caller holding a waker for a finished sleep would resolve
    // nothing and hide that its wake did not work.
    expect(wakes.at(-1)).toBeNull();
    expect(signal.outstanding).toBe(0);
  });

  // The two call sites are the point. A helper that is correct and unused
  // leaves the leak exactly where it was -- and this repository had the correct
  // version of these lines sitting next to the leaking one for months.
  test("neither hub loop keeps its own copy of this", async () => {
    for (const path of ["src/hub/audit-worker.ts", "src/hub/lane-hub-connection.ts"]) {
      const source = codeOnly(await Bun.file(path).text(), "slash");
      expect(source).toContain("abortableSleep(");
      // Not "no abortableSleep call" -- no hand-rolled abort listener at all.
      // The strong form is what found the third copy: a wait-until-abort in the
      // conflict branch that this test did not know existed.
      expect(source).not.toContain("addEventListener(");
    }
  });
});
