import { describe, expect, test } from "bun:test";

/**
 * A zero denominator must not be a pass.
 *
 * `mutation-check` printed `0/0 caught` and exited 0 when nothing was selected —
 * measured, not assumed: the selection was emptied and the program exited 0.
 * That is a green meaning *nothing ran*, produced by the one tool whose job is
 * to say whether the checks check anything.
 *
 * The same shape turned up in three repositories the same night, which is why
 * this is a test and not a comment: `0 pass` cannot tell "did not run" from
 * "all failed" unless something refuses the zero.
 */
/**
 * `--list` rather than a real run: the guard is what is under test, and running
 * the set would edit `package.json` while the rest of the suite reads it.
 */
async function mutationCheck(...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // `--list` mutates nothing, so the nesting refusal does not apply to it --
  // and leaving the variable set would make this file "catch" its own mutation
  // by tripping that refusal instead of the guard under test. A catch for the
  // wrong reason is not a catch.
  const { AGENT_MESH_MUTATION_ACTIVE: _nesting, ...env } = process.env;
  const child = Bun.spawn(["bun", "scripts/mutation-check.ts", "--list", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout, stderr };
}

describe("empty selection", () => {
  test("a selection matching nothing is refused, not reported as a pass", async () => {
    const { exitCode, stdout, stderr } = await mutationCheck("--fast", "--only", "no-such-mutation-anywhere");
    expect(exitCode).toBe(2);
    // The message has to carry the denominator. "no mutation selected" alone
    // leaves the reader guessing whether the set is empty or the filter missed.
    expect(stderr).toContain("no mutation selected");
    expect(stderr).toContain("in the set");
    expect(stdout).not.toContain("0/0");
  });

  // Without this the test above passes for a program that refuses every run,
  // proving only that the guard can fire and never that it can stay quiet.
  test("and a selection matching something is not refused", async () => {
    const { exitCode, stdout, stderr } = await mutationCheck("--fast", "--only", "package.json");
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("no mutation selected");
    expect(stdout).toMatch(/\n[1-9]\d*\/\d+ selected\n/);
  });
});
