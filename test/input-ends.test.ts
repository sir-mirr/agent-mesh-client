import { describe, expect, test } from "bun:test";

/**
 * A TUI whose terminal went away must leave, not spin.
 *
 * Three `agent-mesh` processes were found on a development machine at 82 hours
 * of CPU time each -- started by an editor that had since exited, holding a pty
 * nobody was on the other end of. Every screen parks on a promise only a
 * keypress settles, so when the master closes there is nothing to settle it and
 * the process does not block: it burns a core.
 *
 * Listening was not enough, which is why this test exists rather than a
 * comment. Measured on the released binary: 94.9% with no handler, 90.1% with
 * an empty `end` listener, 99.2% closing the readline interface, 0% on exit.
 */
async function underPty(
  fixture: string,
): Promise<{ alive: boolean; exit: number | null; left_on: string; saw: string }> {
  // Bun has no openpty, and nothing else here can close the far end of a
  // terminal. python3 is present on both CI runners; if it is not, this fails
  // loudly rather than reporting a pass it did not measure.
  const trace = `/tmp/agent-mesh-input-trace-${fixture.replace(/\W/g, "-")}`;
  for (const path of [trace, `${trace}.seen`]) {
    await Bun.file(path).delete().catch(() => {});
  }
  const child = Bun.spawn(["python3", "test/pty-runner.py", "1", "6", "bun", fixture], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AGENT_MESH_INPUT_TRACE: trace },
  });
  const stdout = await new Response(child.stdout).text();
  await child.exited;
  const result = JSON.parse(stdout);
  // What the platform actually produced. Without this a Linux failure says only
  // "still running", and the next guess costs another run to test.
  result.left_on = await Bun.file(trace).text().catch(() => "");
  result.saw = await Bun.file(`${trace}.seen`).text().catch(() => "");
  return result;
}

describe("terminal input ending", () => {
  test("the TUI leaves when the terminal closes", async () => {
    const result = await underPty("test/fixtures/input-ends-guarded.ts");
    expect({ alive: result.alive, exit: result.exit, saw: result.saw, left_on: result.left_on })
      .toMatchObject({ alive: false, exit: 2 });
  }, 30_000);

  // The control. Without it this passes against a fixture that exits for any
  // reason at all, and would have passed just as well before the guard existed.
  test("and without the guard it is still running", async () => {
    const result = await underPty("test/fixtures/input-ends-bare.ts");
    expect(result.alive).toBe(true);
  }, 30_000);

  // The guard is only reached because runTui installs it.
  test("runTui installs it", async () => {
    const source = await Bun.file("src/tui/app.ts").text();
    const code = source.split("\n").filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"));
    const body = code.slice(code.findIndex((line) => line.includes("export async function runTui")));
    expect(body.some((line) => line.trim() === "exitWhenInputEnds();")).toBe(true);
  });
});
