import { describe, expect, test } from "bun:test";
import { E2E_SCENARIOS } from "@agent-mesh/contracts";
import { duplicateIdMessage, duplicateIds } from "../e2e/scenario-ids";
import { codeOnly } from "./support/code-only";

describe("duplicate scenario ids", () => {
  test("an id used twice is reported", () => {
    expect(duplicateIds([{ id: "A" }, { id: "B" }, { id: "A" }])).toEqual(["A"]);
  });

  // Without this the check above passes for a function that calls everything a
  // duplicate, which would refuse every run this repository makes.
  test("and a set of distinct ids is not", () => {
    expect(duplicateIds([{ id: "A" }, { id: "B" }, { id: "C" }])).toEqual([]);
    expect(duplicateIds([])).toEqual([]);
  });

  test("an id used three times is reported once, and offenders come back sorted", () => {
    expect(duplicateIds([{ id: "B" }, { id: "A" }, { id: "B" }, { id: "A" }, { id: "B" }])).toEqual([
      "A",
      "B",
    ]);
  });

  // The count of the whole set goes in the message for the same reason it does
  // in the empty-selection refusal: "duplicate id" alone cannot tell a
  // two-entry mistake from a set duplicated wholesale.
  test("the message names the offenders and the size of the set", () => {
    const message = duplicateIdMessage(["E2E-AUTH-KEYSTREAM-002"], 124);
    expect(message).toContain("E2E-AUTH-KEYSTREAM-002");
    expect(message).toContain("124");
    expect(message).toContain("1 scenario id used more than once");
  });

  test("plural when there is more than one", () => {
    expect(duplicateIdMessage(["A", "B"], 9)).toContain("2 scenario ids used more than once");
  });

  // The set this repository actually runs. `E2E-AUTH-KEYSTREAM-002` was used
  // twice here and the platform side found it, because a duplicate passes the
  // tally: both entries are selected, both run, both report.
  test("the contract set in use holds no duplicate", () => {
    expect(duplicateIds(E2E_SCENARIOS)).toEqual([]);
  });

  // A guard nothing calls is a guard that catches nothing, and this one is
  // cheap enough to be easy to drop in a refactor.
  test("the runner refuses before it selects", async () => {
    const source = codeOnly(await Bun.file("e2e/scenario-runner.ts").text(), "slash");
    expect(source).toContain("duplicateIds(E2E_SCENARIOS)");
    // Before the selection, not after: a duplicate has to be refused whether or
    // not `--only` happens to filter it away.
    expect(source.indexOf("duplicateIds(E2E_SCENARIOS)")).toBeLessThan(
      source.indexOf("const selected ="),
    );
  });
});
