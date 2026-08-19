import { describe, expect, test } from "bun:test";
import { tallyMismatch } from "../e2e/scenario-tally";

/**
 * A total that divides by what came back cannot report what went missing.
 *
 * `17/17 contract scenarios` reads as a complete pass. It is also what a run of
 * eighteen prints when one produced no result at all.
 */
describe("scenario tally", () => {
  test("a scenario that produced no result is refused, not divided away", () => {
    const message = tallyMismatch(18, 17);
    expect(message).toContain("17");
    expect(message).toContain("18");
  });

  // Without this the check above passes for a function that always complains,
  // which would refuse every run this exists to let through.
  test("and a complete run is not refused", () => {
    expect(tallyMismatch(18, 18)).toBeNull();
    expect(tallyMismatch(0, 0)).toBeNull();
  });

  // The runner has to divide by the selection. Dividing by the results is the
  // defect itself, so the source is checked rather than assumed.
  test("the runner divides by the selection", async () => {
    const source = await Bun.file("e2e/scenario-runner.ts").text();
    const code = source.split("\n").filter((line) => !line.trim().startsWith("*")).join("\n");
    expect(code).toContain("/${selected.length} contract scenarios");
    expect(code).toContain("tallyMismatch(selected.length, results.length)");
  });
});
