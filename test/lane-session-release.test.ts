import { describe, expect, test } from "bun:test";
import { laneTmuxSession } from "../src/config/paths";
import { releaseLaneSession } from "../src/runtime/attach";

/**
 * Removing an agent has to close the terminal it was living in.
 *
 * `attach` opens `mesh-lane-<identity>` for every runtime, but the only code
 * that ever killed one was the Claude supervisor killing its own. Removing a
 * Codex agent looked clean by accident -- its client exits when the app-server
 * does. An Antigravity agent left `agy` running at 13.6% CPU in a session
 * belonging to a lane that `lane list` no longer reported at all. Three such
 * strays were found on a development host; the machine stopped running hot when
 * they were closed.
 *
 * tmux is required, not skipped around: this repository already needs it to
 * attach, and a test that quietly passes when the thing it drives is missing is
 * the kind of green this file exists to refuse.
 */
const TEST_IDENTITY = "release-probe-agent";

function sessionExists(name: string): boolean {
  return Bun.spawnSync(["tmux", "has-session", "-t", name], { stdout: "ignore", stderr: "ignore" })
    .exitCode === 0;
}

describe("lane session release", () => {
  test("closes the session a removed agent was living in", () => {
    expect(Bun.which("tmux")).toBeTruthy();
    const session = laneTmuxSession(TEST_IDENTITY);
    Bun.spawnSync(["tmux", "kill-session", "-t", session], { stdout: "ignore", stderr: "ignore" });
    Bun.spawnSync(["tmux", "new-session", "-d", "-s", session, "sleep", "120"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(sessionExists(session)).toBe(true);
    try {
      expect(releaseLaneSession(TEST_IDENTITY)).toBe("closed");
      expect(sessionExists(session)).toBe(false);
    } finally {
      Bun.spawnSync(["tmux", "kill-session", "-t", session], { stdout: "ignore", stderr: "ignore" });
    }
  });

  // Without this, a function that reported "closed" unconditionally would pass
  // the test above -- and the caller prints that word to a person.
  test("and says so when there was nothing to close", () => {
    expect(releaseLaneSession("no-such-agent-here")).toBe("absent");
  });

  // Both removal paths, because a guard in one is a guard the other walks
  // around. Comment lines are stripped: prose naming the call is not the call.
  test("both removal paths call it", async () => {
    for (const file of ["src/cli.ts", "src/tui/app.ts"]) {
      const code = (await Bun.file(file).text())
        .split("\n")
        .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"));
      expect(code.some((line) => /releaseLaneSession\(/.test(line) && !line.includes("import")))
        .toBe(true);
    }
  });
});
