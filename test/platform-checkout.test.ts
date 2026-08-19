import { describe, expect, test } from "bun:test";
import { mayAlign, missingCheckoutMessage } from "../e2e/platform-checkout";

/**
 * The runner may move its own checkout and no other.
 *
 * It used to spawn the harness from the platform author's working tree. Over
 * one evening that tree was two commits behind with two files modified, then
 * clean and one ahead, then two behind again — and one run caught it
 * mid-mutation and reported ten of eighteen scenarios failing on signatures, a
 * defect present in no commit. A result has to name something anyone can fetch.
 */
describe("platform checkout", () => {
  test("the runner's own checkout may be aligned", () => {
    expect(mayAlign(undefined)).toBe(true);
    expect(mayAlign("")).toBe(true);
  });

  // The half that matters. Checking out over somebody's work is the thing this
  // exists to stop doing, so a pointed-at checkout is read and never written.
  test("and a checkout someone pointed at is never moved", () => {
    expect(mayAlign("/Users/someone/work/agent-mesh-platform-main")).toBe(false);
    expect(mayAlign("../elsewhere")).toBe(false);
  });

  // A missing checkout has to say how to make one. Falling back to a working
  // tree would be the old behaviour arriving silently.
  test("a missing checkout names the path and the command", () => {
    const message = missingCheckoutMessage("/tmp/some/path");
    expect(message).toContain("/tmp/some/path");
    expect(message).toContain("git clone");
    expect(message).toContain("AGENT_MESH_E2E_PLATFORM");
  });
});
