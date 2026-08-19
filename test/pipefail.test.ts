import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

/**
 * A pipeline reports the last command's exit status, not the failing one.
 *
 * `gh run watch … | tail` followed by `$?` reads tail's status, and tail
 * succeeds at printing a failure. That is how a red CI run was nearly reported
 * here as green -- caught by looking again, which is not a mechanism.
 *
 * GitHub's default shell for `run:` is `bash -e`, which stops on a failing
 * command but not on a failing one inside a pipeline: `-o pipefail` is only
 * added when a step names `shell: bash`. So a block with a pipe and no pipefail
 * can pass while the interesting half failed.
 */
interface Block {
  file: string;
  line: number;
  body: string[];
}

function runBlocks(): Block[] {
  const blocks: Block[] = [];
  for (const file of readdirSync(".github/workflows")) {
    const lines = require("node:fs").readFileSync(`.github/workflows/${file}`, "utf8").split("\n");
    lines.forEach((line: string, index: number) => {
      if (!/run:\s*\|/.test(line)) return;
      const indent = line.length - line.trimStart().length;
      const body: string[] = [];
      for (const next of lines.slice(index + 1)) {
        if (next.trim() && next.length - next.trimStart().length <= indent) break;
        body.push(next);
      }
      blocks.push({ file, line: index + 1, body });
    });
  }
  return blocks;
}

/**
 * A pipe, not an `||`. Deliberately approximate: it is allowed to ask for
 * pipefail on a block that did not need it, and must not miss one that did.
 */
function pipes(body: string[]): string[] {
  return body.filter((line) => {
    const code = line.trim();
    if (code.startsWith("#")) return false;
    return /[^|]\|[^|]/.test(code);
  });
}

describe("pipefail", () => {
  test("every run block with a pipeline sets pipefail", () => {
    const offenders = runBlocks()
      .filter((block) => pipes(block.body).length > 0)
      .filter((block) => !block.body.join("\n").includes("pipefail"))
      .map((block) => `${block.file}:${block.line}`);
    expect(offenders).toEqual([]);
  });

  // The enumeration has to reach the workflows. An empty list satisfies the
  // test above for a repository with no workflows at all, and this one has two.
  test("and the enumeration actually reaches them", () => {
    const blocks = runBlocks();
    expect(blocks.length).toBeGreaterThan(2);
    expect(new Set(blocks.map((block) => block.file)).size).toBeGreaterThan(1);
  });

  // The matcher has to be able to say no, or the first test passes because it
  // finds nothing rather than because nothing is wrong.
  test("and the matcher can say no", () => {
    expect(pipes(["  gh run watch 123 | tail -3"])).toHaveLength(1);
    expect(pipes(["  brew list tmux || brew install tmux"])).toHaveLength(0);
    expect(pipes(["  # a | in a comment"])).toHaveLength(0);
  });
});
