/**
 * Sleep until a deadline, a wake, or an abort — releasing the abort listener
 * on every path out.
 *
 * This exists because two copies of the same twelve lines lived in this
 * repository, one correct and one not. `LaneHubConnection.#sleep` removed its
 * `"abort"` listener when the timer won; `AuditWorker.#wait` did not. The audit
 * worker polls once a second for the life of a lane, so the miss registered a
 * fresh listener every second onto an `AbortSignal` that is only aborted when
 * the lane stops — an unbounded list, permanently retained, with `{ once: true }`
 * unable to help because it only unregisters on fire.
 *
 * It was found while hunting a CPU ramp, and it is **not** that ramp: measured
 * at 2.44 ns per already-registered listener, ninety minutes of accumulation
 * costs about 0.0014% of a core, some three hundred times too little, and it
 * grows without bound rather than levelling off. It is a real leak that happens
 * to be too small to have been the thing we were looking for. Both facts are
 * worth keeping: the fix is right, and it does not close the investigation.
 *
 * One function rather than two, because the difference between the copies was
 * invisible until something went looking for it.
 */

/**
 * Structural rather than `AbortSignal`, so a test can count what was registered
 * and what was released. A real `AbortSignal` satisfies this; nothing about the
 * behaviour here needs more than it.
 */
export interface AbortLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/**
 * `registerWake` hands the caller a function that ends this sleep early, and is
 * called with `null` once the sleep is over so the caller does not hold a waker
 * for a sleep that already finished.
 */
export function abortableSleep(
  milliseconds: number,
  signal: AbortLike,
  registerWake?: (wake: (() => void) | null) => void,
): Promise<void> {
  if (signal.aborted) {
    registerWake?.(null);
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      registerWake?.(null);
      resolve();
    };
    const onAbort = () => finish();
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    registerWake?.(finish);
  });
}

/**
 * Wait until the signal aborts, and nothing else.
 *
 * The third hand-rolled copy of this pattern in the two hub loops. This one is
 * one-shot per entry into a terminal state, so it never accumulated and was
 * never a leak — it is here because the leak that mattered was invisible while
 * a correct copy sat beside it, and three copies is how that happens twice.
 */
export function untilAborted(signal: AbortLike): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
