import { describe, expect, test } from "bun:test";
import { touchesSurface } from "../scripts/contract-surface";

/**
 * `18/18` twice is two different facts: the run asked its questions of changed
 * code, or of code nothing changed in. Counting both as coverage overstates it,
 * and the call used to be made by reading commit titles.
 */
describe("contract surface", () => {
  test("hub and service code is on the path the scenarios take", () => {
    expect(touchesSurface(["packages/hub/src/rest/agents.ts"])).toHaveLength(1);
    expect(touchesSurface(["packages/http/src/main.ts"])).toHaveLength(1);
  });

  // Without this everything counts as surface and the distinction PM asked for
  // disappears -- which is the same as never making it.
  test("and screens, docs and scripts are not", () => {
    expect(touchesSurface([
      "packages/http/src/ui/admin.ts",
      "docs/architecture.md",
      "scripts/e2e-harness.ts",
      "packages/web/src/App.tsx",
    ])).toEqual([]);
  });

  // A platform test file changed in the same range as its source, and the metric
  // counted both -- reporting that a run might have asked something of changed
  // code when half of what changed was the platform checking itself.
  test("and a test file is not code a scenario reaches", () => {
    expect(touchesSurface([
      "packages/http/src/main.in-process.test.ts",
      "packages/hub/test/signature.test.ts",
    ])).toEqual([]);
    // The source beside it still counts.
    expect(touchesSurface(["packages/http/src/main.ts"])).toHaveLength(1);
  });

  test("a mixed range reports only the parts on the path", () => {
    expect(touchesSurface([
      "packages/http/src/ui/chat.ts",
      "packages/hub/src/signature.ts",
      "README.md",
    ])).toEqual(["packages/hub/src/signature.ts"]);
  });
});
