import { describe, expect, test } from "bun:test";
import { MUTATIONS } from "../scripts/mutations";

/**
 * No mutation is sitting in the committed source.
 *
 * A neighbouring repository had one on `main` for three days: an authentication
 * guard deleted, inside a commit about something else entirely. Its tool kept a
 * single backup copy, two mutations were applied before a restore, and the
 * "restore" wrote back the first mutation.
 *
 * `scripts/mutate.ts` cannot do that — it keeps no copy at all, restores with
 * `git checkout --`, refuses to start on a dirty tree and refuses to finish on
 * one. But that is an argument about one tool, and the thing worth guarding is
 * the source, not the tool. A tool that dies between the edit and the restore
 * leaves the edit; a hand-run `sed` leaves it too. The check that survives all
 * of those reads what was committed.
 *
 * Two directions, because a mutation is a swap and either side can be the tell:
 *
 *   the replacement is present and the original is gone   a swap was committed
 *   the original is gone and nothing replaced it          a deletion was committed
 *
 * The second is what `mutation-check` already reports as REFUSED — it cannot
 * find its anchor — which is why that outcome exists at all. Here it is stated
 * as a test so it fails on a push rather than the next time someone runs the
 * whole set.
 */
describe("no leftover mutation in the committed source", () => {
  test("every anchor still matches, so nothing was committed in a mutated state", async () => {
    const missing: string[] = [];
    for (const entry of MUTATIONS) {
      const source = await Bun.file(entry.file).text();
      if (!source.includes(entry.find)) missing.push(`${entry.file}: ${entry.find.slice(0, 60)}`);
    }
    // A missing anchor is ambiguous on its own -- it is also what a rename
    // looks like -- but both readings are things to act on, and both are
    // invisible until someone asks.
    expect(missing).toEqual([]);
  });

  test("and no replacement text is sitting where its original should be", async () => {
    const leftover: string[] = [];
    for (const entry of MUTATIONS) {
      if (!entry.replace.trim()) continue;
      const source = await Bun.file(entry.file).text();
      if (source.includes(entry.replace) && !source.includes(entry.find)) {
        leftover.push(`${entry.file}: ${entry.replace.slice(0, 60)}`);
      }
    }
    expect(leftover).toEqual([]);
  });

  // Without this the two checks above pass for an empty set, which is what a
  // refactor that stopped exporting the entries would produce.
  test("and the set it checks is not empty", () => {
    expect(MUTATIONS.length).toBeGreaterThan(20);
  });
});
