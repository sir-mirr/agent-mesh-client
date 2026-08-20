#!/usr/bin/env bun
/**
 * Break each guard this repository relies on, and check that something fails.
 *
 * These were run by hand and the results written into commit messages. That is
 * a claim about work done once, and **the claim outlives the guard it
 * describes**: if an expectation is deleted next year, the sentence in the
 * commit still reads exactly as true as it does today. Committing the set makes
 * the claim re-runnable, which is the only form of it worth anything.
 *
 * Every entry names a defect that actually reached this repository -- none are
 * invented -- and the check now standing between it and a release. A guard that
 * cannot be broken here is a guard nobody has evidence for.
 *
 *   bun run mutation-check          everything
 *   bun run mutation-check --fast   only the ones that need no mesh
 *
 * The mesh-backed entries start a real hub through the platform harness and
 * take about half a minute each. They are in the default run because leaving
 * them out would make the fast path the one people quote, and the expensive
 * ones are where the interesting failures were.
 */

import { MutationRefused, runMutation, type Mutation } from "./mutate";
import { MUTATIONS, RUNNER, SCOPE, scenario, scopeTest, typecheck, type Entry } from "./mutations";

// Fatal here rather than per entry. Inside another mutation every entry refuses
// for a reason that has nothing to do with the guard it names, and a refusal
// counts as a failure -- so a self-check that never ran would report that every
// entry behaved correctly. Refusing to start is the only answer that is not a
// wrong one.
if (process.env.AGENT_MESH_MUTATION_ACTIVE) {
  process.stderr.write("cannot run inside another mutation: nothing here would be measuring itself\n");
  process.exit(2);
}



type Outcome = "caught" | "NOT CAUGHT" | "REFUSED" | "INCONCLUSIVE";

/**
 * The contract pin, read rather than written down here.
 *
 * A literal `v0.18.0` in the entry below would go stale on the next bump and
 * refuse -- loudly, but for a reason that has nothing to do with the guard it
 * names, and every bump would need this file edited to match. The version has
 * one home, and the same reasoning removed the ignore list from the scope test
 * and the backup copy from the mutation tool.
 */



/**
 * Two mutations that must **not** be caught, for `--self-check`.
 *
 * The failure branch of this file had never executed. A set that all passes
 * never prints `NOT CAUGHT`, so the code saying a guard is missing was itself a
 * check nobody had seen work -- this file appearing inside the tool written to
 * find it.
 *
 * (Both sentences said "five" and "nine" until the set grew. A sentence that
 * counts a list drifts beside it, which is the same defect as an ADR headed
 * "four rules" over seven and a README pinning a tag three behind.)
 *
 * It was first confirmed by hand, which is the objection that put the set in
 * the repository in the first place: a proof living only in a transcript
 * outlives what it describes. So it is a command.
 *
 * One entry for each way a mutation stops being evidence. The second is the
 * more dangerous: a rename leaves the pattern unmatched, the command runs
 * against untouched source and passes, and that reads as the guard failing to
 * catch a real defect — a wrong finding rather than a missing one.
 *
 * **Each declares how it must fail, not merely that it must.** Counting
 * failures passes when both entries refuse — which is what a rename to the
 * first entry's anchor would produce — and then the reporting branch under test
 * has still never run while the count says 2/2. The platform side found that in
 * theirs by letting the baseline drift a single character.
 */
const SELF_CHECK: (Entry & { mustFailAs: Outcome })[] = [
  {
    defect: "TEMPORARY: an edit inside a comment, which no guard could object to.",
    mustFailAs: "NOT CAUGHT",
    file: SCOPE,
    find: "Every TypeScript file in this repository is inside the checked scope.",
    replace: "Every TypeScript file in this repository is within the checked scope.",
    command: scopeTest,
    evidence: "unused: this entry must not fail at all",
  },
  {
    defect: "TEMPORARY: a pattern that is no longer present, as a rename would leave it.",
    mustFailAs: "REFUSED",
    file: SCOPE,
    find: "a-string-this-file-does-not-contain",
    replace: "irrelevant",
    command: scopeTest,
    evidence: "unused: this entry is refused before anything runs",
  },
  {
    // The third way a run says nothing: it exits non-zero having never reached
    // a verdict. A crashed child, a harness that never bound its port. Forced
    // here by asking for a marker the run cannot print, so the branch that
    // separates "the guard caught it" from "we never found out" is exercised
    // by a command rather than by hand.
    defect: "TEMPORARY: a run that fails without ever reporting.",
    mustFailAs: "INCONCLUSIVE",
    file: SCOPE,
    find: "expect(outside).toEqual([]);",
    replace: 'expect(outside).toEqual(["forced"]);',
    command: scopeTest,
    evidence: "a-marker-no-run-prints",
  },
];

async function evaluate(entry: Entry): Promise<{ outcome: Outcome; detail: string }> {
  try {
    const { exitCode, output } = await runMutation(entry);
    if (exitCode === 0) return { outcome: "NOT CAUGHT", detail: entry.defect };
    const evidence = entry.evidence;
    if (!output.includes(evidence)) {
      return {
        outcome: "INCONCLUSIVE",
        detail: `exited ${exitCode} without reporting (no "${evidence}"): ${output.trim().split("\n").pop() ?? ""}`,
      };
    }
    return { outcome: "caught", detail: "" };
  } catch (error) {
    // A refusal is not a result. Counting it as caught would let a mutation
    // that stopped matching -- a rename, a rewrite -- report success forever.
    return {
      outcome: "REFUSED",
      detail: error instanceof MutationRefused ? error.message : String(error),
    };
  }
}

if (process.argv.includes("--self-check")) {
  let wrong = 0;
  for (const entry of SELF_CHECK) {
    const { outcome, detail } = await evaluate(entry);
    if (outcome === entry.mustFailAs) {
      process.stdout.write(`${outcome.padEnd(11)} ${detail.split("\n")[0]}\n`);
      continue;
    }
    wrong += 1;
    process.stdout.write(
      `expected to fail as "${entry.mustFailAs}", got "${outcome}": ${entry.defect}\n`,
    );
  }
  process.stdout.write(
    wrong === 0
      ? `\nself-check: ${SELF_CHECK.length}/${SELF_CHECK.length} failed the way they must\n`
      : `\nself-check FAILED: ${wrong} did not fail the way it must — the reporting branch is untested\n`,
  );
  // One layer, and then a stop. A self-check of the self-check has no end, and
  // the place to stop was chosen by going one layer further and watching it
  // bite rather than by deciding where it felt like enough.
  process.exit(wrong === 0 ? 0 : 1);
}

// `--collect` prints what each mutated run actually said, so an entry's
// evidence can be taken from a real run instead of guessed. A predicted
// message is a copy of a format that lives somewhere else; a collected one is
// wrong loudly on the next run when that format changes.
if (process.argv.includes("--collect")) {
  for (const entry of MUTATIONS) {
    const { exitCode, output } = await runMutation(entry);
    const interesting = output
      .split("\n")
      .filter((line) => /step \d+|error TS|\(fail\)|harness applied|Error:/.test(line));
    process.stdout.write(`--- ${entry.command.slice(1).join(" ")} (exit ${exitCode})\n`);
    for (const line of interesting.slice(0, 3)) process.stdout.write(`    ${line.trim()}\n`);
  }
  process.exit(0);
}

const fast = process.argv.includes("--fast");
// A substring of the file or the evidence, so one mutation can be re-run on its
// own. It also gives a test a way to drive this program to an empty selection,
// which is the state the guard below exists for.
const onlyFlag = process.argv.indexOf("--only");
const only = onlyFlag === -1 ? undefined : process.argv[onlyFlag + 1];
let selected = fast ? MUTATIONS.filter((entry) => !entry.slow) : MUTATIONS;
if (only !== undefined) {
  selected = selected.filter((entry) => entry.file.includes(only) || entry.evidence.includes(only));
}
if (fast) {
  process.stdout.write(`skipping ${MUTATIONS.length - selected.length} mesh-backed mutation(s)\n\n`);
}
// A zero denominator is not a pass. With nothing selected the loop below runs
// zero times, `missed` stays zero, and this program prints `0/0 caught` and
// exits 0 -- a green saying nothing ran, in the tool whose whole job is to say
// whether the checks check anything. Measured before this line existed:
// selection emptied, exit 0.
if (selected.length === 0) {
  process.stderr.write(
    `no mutation selected${only === undefined ? "" : ` by ${JSON.stringify(only)}`}` +
      ` — of ${MUTATIONS.length} in the set. Nothing ran, which is not the same as nothing wrong.\n`,
  );
  process.exit(2);
}
// Deliberately after the guard: `--list` answers "what would run", and on an
// empty selection the answer is a refusal rather than an empty list.
if (process.argv.includes("--list")) {
  for (const entry of selected) process.stdout.write(`${entry.file} — ${entry.evidence}\n`);
  process.stdout.write(`\n${selected.length}/${MUTATIONS.length} selected\n`);
  process.exit(0);
}

let missed = 0;
const tally = new Map<Outcome, number>();
for (const [index, entry] of selected.entries()) {
  const label = `${index + 1}/${selected.length} ${entry.file} ${entry.command.slice(1).join(" ")}`;
  const { outcome, detail } = await evaluate(entry);
  tally.set(outcome, (tally.get(outcome) ?? 0) + 1);
  if (outcome !== "caught") missed += 1;
  process.stdout.write(
    outcome === "caught" ? `caught      ${label}\n` : `${outcome.padEnd(11)} ${label}\n            ${detail}\n`,
  );
}

// The context goes on the total line, not only in a header. `5/5 caught` is
// character-for-character what a clean full run prints, and a reader who scrolls
// to the last line sees a complete pass. The platform side had the same shape in
// theirs, found by asking their tool this repository's question rather than by
// being told the answer.
//
// And the remainder is broken out by kind, because `0/9 caught` reads as nine
// checkers that failed to notice when the truth was nine that never ran — a
// refusal on a dirty tree prints exactly that. A count of what did not happen
// is not a count of what went wrong.
const remainder = [...tally]
  .filter(([outcome]) => outcome !== "caught")
  .map(([outcome, count]) => `${count} ${outcome}`)
  .join(", ");
process.stdout.write(
  `\n${selected.length - missed}/${selected.length} caught` +
    (fast ? ` — fast subset, of ${MUTATIONS.length} in the set` : "") +
    (remainder ? ` (${remainder})` : "") +
    "\n",
);
process.exit(missed === 0 ? 0 : 1);
