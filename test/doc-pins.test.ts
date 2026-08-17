/**
 * The contract version the READMEs state is the one this repository installs.
 *
 * Both READMEs said `v0.14.1` three tags after the fact. That was corrected by
 * hand, and one round later they said `v0.17.0` against an installed
 * `v0.18.0` -- the same drift, in the same two lines, within an hour. Nothing
 * else in the repository reads those lines, so nothing else could notice.
 *
 * A guard is worth adding here and was not worth adding on the platform side,
 * which has no pin in its prose at all: a check with no subject is one more
 * thing that reports green while looking at nothing. Two subjects, twice
 * wrong, is a different case.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DOCUMENTS = ["README.md", "README.kr.md"];

/** Every contract version this file mentions, in order. */
function pinsIn(text: string): string[] {
  return [...text.matchAll(/agent-mesh-contracts[^\n]*?\bv(\d+\.\d+\.\d+)/g)].map((match) => match[1]!);
}

describe("documented contract pin", () => {
  const dependency = (
    JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    }
  ).dependencies["@agent-mesh/contracts"];
  const installed = dependency?.match(/#v(\d+\.\d+\.\d+)/)?.[1];

  test("package.json pins a tag rather than a branch", () => {
    // Without this the comparison below has nothing to compare against and
    // passes for any prose at all.
    expect(installed).toMatch(/^\d+\.\d+\.\d+$/);
  });

  for (const document of DOCUMENTS) {
    test(`${document} states the installed version`, () => {
      const pins = pinsIn(readFileSync(join(ROOT, document), "utf8"));
      // Named before compared. A file that stopped mentioning the contract
      // would otherwise satisfy this by having nothing to disagree with --
      // the same empty-set pass that let a scope check cover a repository with
      // no source in it.
      expect(pins.length).toBeGreaterThan(0);
      expect([...new Set(pins)]).toEqual([installed!]);
    });
  }
});
