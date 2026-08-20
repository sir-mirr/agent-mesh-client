import { describe, expect, test } from "bun:test";
import { codeOnly } from "./support/code-only";

/**
 * The half that was left open.
 *
 * Stripping whole comment lines stopped an assertion being satisfied by the
 * comment above a step. A comment on the end of a line survived that, and
 * `- run: echo hi  # scripts/set-version.ts` still satisfied both a `contains`
 * check and a regex anchored on `run:` -- measured, both true, before this.
 */
describe("code only", () => {
  test("a trailing comment cannot satisfy an assertion about the line", () => {
    const stripped = codeOnly("      - run: echo hi  # scripts/set-version.ts");
    expect(stripped).not.toContain("set-version");
    expect(/^\s*-?\s*run:.*scripts\/set-version\.ts/.test(stripped)).toBe(false);
  });

  test("and a whole comment line still cannot", () => {
    expect(codeOnly("   # calls scripts/set-version.ts")).not.toContain("set-version");
    expect(codeOnly("   * calls scripts/set-version.ts")).not.toContain("set-version");
    expect(codeOnly("   // calls releaseLaneSession()", "slash")).not.toContain("releaseLaneSession");
  });

  // The controls: it has to leave real code alone, or every contains-assertion
  // built on it fails for the wrong reason and someone deletes the check.
  test("and real code survives", () => {
    expect(codeOnly("      - run: bun run scripts/set-version.ts"))
      .toContain("scripts/set-version.ts");
    expect(codeOnly('  releaseLaneSession(lane.identity);', "slash"))
      .toContain("releaseLaneSession");
    // A marker inside a token is not a comment: a URL fragment survives.
    expect(codeOnly("  curl https://example.test/page#section")).toContain("#section");
  });
});
