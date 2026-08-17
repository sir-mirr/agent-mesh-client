/**
 * The CLI reports the version the manifest holds, not a second copy of it.
 *
 * `src/cli.ts` carried `const VERSION = "0.1.0-dev.0"` while `package.json`
 * said the same thing and the git tag said a third. The v0.1.1 release shipped
 * a binary whose `--version` answered `0.1.0-dev.0` — a version matching no tag
 * anyone could have installed, and nothing anywhere compared the two.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("reported version", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version: string;
  };

  test("the CLI reads it rather than repeating it", () => {
    const source = readFileSync(join(ROOT, "src/cli.ts"), "utf8");
    // A literal here is the defect itself, so the check is for its absence
    // rather than for its value.
    expect(source).toContain("packageManifest.version");
    expect(source).not.toMatch(/const VERSION = ["\']/);
  });

  test("the manifest version is a version", () => {
    // Without this the case above passes against a manifest holding anything at
    // all, including the empty string the release step would write if the tag
    // were malformed.
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});
