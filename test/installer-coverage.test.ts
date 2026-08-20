import { describe, expect, test } from "bun:test";
import { codeOnly } from "./support/code-only";

/**
 * The installer is served straight off `main`.
 *
 * `curl … raw.githubusercontent.com/…/main/install.sh | sh` is the line in the
 * release notes, which means an edit to `install.sh` reaches every user the
 * moment it is pushed -- with no tag, no build and, until these steps existed,
 * nothing that had run it. Its only mention anywhere in `.github/` was the
 * sentence telling people to run it.
 */
async function runnableLines(path: string): Promise<string> {
  const text = await Bun.file(path).text();
  return codeOnly(text);
}

describe("installer coverage", () => {
  test("ci runs the installer on every push", async () => {
    const ci = await runnableLines(".github/workflows/ci.yml");
    expect(ci).toContain("sh install.sh");
    // Installing into the runner's real bin directory would make the step pass
    // by changing the machine it runs on. The escape hatches exist; use them.
    expect(ci).toContain("AGENT_MESH_INSTALL_DIR");
    expect(ci).toContain("AGENT_MESH_INSTALL_SERVICE=0");
  });

  test("the release takes the path a user takes to it", async () => {
    const release = await runnableLines(".github/workflows/release.yml");
    expect(release).toContain("raw.githubusercontent.com");
    expect(release).toContain("AGENT_MESH_VERSION");
  });

  // Without this the tests above pass for an installer that ignores the
  // variables they check for, which is what would make them meaningless.
  test("the installer honours the variables those steps rely on", async () => {
    const installer = await Bun.file("install.sh").text();
    expect(installer).toContain("AGENT_MESH_INSTALL_DIR");
    expect(installer).toContain("AGENT_MESH_INSTALL_SERVICE");
    expect(installer).toContain("AGENT_MESH_VERSION");
  });
});
