/**
 * Whether a scenario run may proceed against the platform checkout it found.
 *
 * Split out of the runner so it can be tested. The runner is a script with
 * top-level `await` that starts real meshes on import, so the decision it makes
 * here would otherwise be reachable only by running one — and a guard nothing
 * can exercise is the shape this repository has spent the day removing.
 */

export interface TreeState {
  /** As the harness reports it: a boolean, or the string form from JSON. */
  dirty: unknown;
  /** `AGENT_MESH_E2E_ALLOW_DIRTY`, or undefined. */
  override: string | undefined;
}

/**
 * A dirty tree is not a measurement.
 *
 * The harness is spawned from the platform checkout, so its hub is whatever
 * that working tree says at that moment — including a guard the other side has
 * deliberately deleted while running its own mutation set. That happened: a run
 * reported 10/18 with `SIGNATURE_INVALID` on every signed route, minutes after
 * 18/18 on the same commit. Reporting it as a contract mismatch would have sent
 * someone after a defect that exists in no commit.
 *
 * Refusing rather than warning, for the reason the mutation tool refuses a
 * dirty tree: a result nobody can reproduce is worse than no result. The
 * override exists because deliberately measuring a work in progress is a real
 * thing to want; it is not the default because wanting it is rarer than
 * colliding with someone else's edit.
 */
export function refusesDirtyTree({ dirty, override }: TreeState): boolean {
  // The string form counts. JSON from the ready file may carry either, and
  // reading only the boolean would let `"true"` through as not-dirty — a guard
  // that answers "clean" for a tree it could not parse.
  const isDirty = dirty === true || dirty === "true";
  return isDirty && override !== "1";
}
