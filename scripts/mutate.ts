#!/usr/bin/env bun
/**
 * Break one thing on purpose, run a command, and put it back.
 *
 * A checker is the only code in a repository that nothing checks, so the way to
 * know one works is to break what it guards and watch it fail. That was being
 * done by hand: copy the file aside, edit it, run, copy it back. The platform
 * side found where that ends -- a single backup slot, two mutations applied
 * before a restore, and the "restore" wrote back the first mutation. A guard
 * was left deleted in the working tree and the suite reported green, because
 * the tool for finding checks that check nothing had made one.
 *
 * So there is no backup copy here. The original is whatever git has, which is
 * the same reasoning that removed the hand-written ignore list from the scope
 * test: a second copy of something already recorded is a second thing that can
 * be wrong.
 *
 *   bun scripts/mutate.ts <file> <find> <replace> -- <command...>
 *
 * Three refusals, each for a way this reports the wrong answer rather than no
 * answer:
 *
 * - A dirty tree, because the restore is `git checkout` and would discard work.
 * - A `find` that matches nothing. The command then runs against unmutated
 *   source and passes, which reads as "the guard did not catch it" -- a wrong
 *   finding, not a missing one, and the expensive kind to act on.
 * - A tree still dirty afterwards. A mutation round ends clean or it has not
 *   ended.
 */

import { $ } from "bun";

const separator = process.argv.indexOf("--");
const [file, find, replace] = process.argv.slice(2, separator === -1 ? undefined : separator);
const command = separator === -1 ? [] : process.argv.slice(separator + 1);

if (!file || find === undefined || replace === undefined || command.length === 0) {
  process.stderr.write("usage: bun scripts/mutate.ts <file> <find> <replace> -- <command...>\n");
  process.exit(2);
}

async function dirty(): Promise<string> {
  return (await $`git status --porcelain`.text()).trim();
}

const before = await dirty();
if (before) {
  process.stderr.write(`refusing to mutate a dirty tree; commit or stash first:\n${before}\n`);
  process.exit(2);
}

const original = await Bun.file(file).text();
if (!original.includes(find)) {
  process.stderr.write(`no match for the mutation in ${file}; nothing was changed\n`);
  process.exit(2);
}
await Bun.write(file, original.replaceAll(find, replace));

const run = Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" });
await $`git checkout -- ${file}`.quiet();

const after = await dirty();
if (after) {
  process.stderr.write(`the tree is still dirty after restoring ${file}:\n${after}\n`);
  process.exit(2);
}

// The mutated run *should* fail. Reported rather than translated: what counts
// as caught is the reader's call, and a tool that decided it would be another
// checker nobody checks.
process.stdout.write(`\nmutated ${file}: command exited ${run.exitCode}\n`);
