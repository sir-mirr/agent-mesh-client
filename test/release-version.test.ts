import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVersion, versionFromRef, writeVersion } from "../scripts/set-version";

describe("release version injection", () => {
  test("a tag becomes the version the binary reports", () => {
    expect(versionFromRef("v0.1.2")).toBe("0.1.2");
    expect(versionFromRef("v1.0.0-rc.1")).toBe("1.0.0-rc.1");
  });

  // Without this the check above passes for a function that strips a leading
  // `v` from anything. `main` would become a version, and the release page
  // would carry a binary answering with a branch name.
  test("and anything that is not a tag is refused", () => {
    for (const ref of ["main", "", "0.1.2", "v0.1", "release/v1.0.0", "v0.1.2 "]) {
      expect(() => versionFromRef(ref)).toThrow();
    }
  });

  // The reason this file exists: the release path was inline shell, so the only
  // way to execute it was to cut a tag. This runs the write on every push.
  test("the manifest holds the tag after writing, read back from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "set-version-"));
    const path = join(dir, "package.json");
    try {
      await Bun.write(path, JSON.stringify({ name: "agent-mesh", version: "0.1.0-dev.0" }, null, 2));
      await writeVersion(path, versionFromRef("v9.9.9"));
      expect(await readVersion(path)).toBe("9.9.9");
      // The rest of the manifest survives; a write that lost `name` would still
      // satisfy a version-only assertion.
      expect((await Bun.file(path).json()).name).toBe("agent-mesh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The workflow is the only caller, and a workflow that stopped calling this
  // would leave every test above passing while releases went back to shipping
  // whatever the manifest happened to say.
  // Comments do not run. The first version of this searched the whole file, and
  // a mutation deleting the run step left it passing -- because the comment
  // above that step names the script. An assertion satisfied by prose about the
  // code is not an assertion about the code.
  test("the release workflow calls this and holds no version logic of its own", async () => {
    const workflow = await Bun.file(".github/workflows/release.yml").text();
    const steps = workflow.split("\n").filter((line) => !line.trim().startsWith("#"));
    expect(steps.some((line) => /^\s*-?\s*run:.*scripts\/set-version\.ts/.test(line))).toBe(true);
    expect(steps.join("\n")).not.toContain("manifest.version =");
  });
});
