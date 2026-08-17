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
 * five are where the interesting failures were.
 */

import { MutationRefused, runMutation, type Mutation } from "./mutate";

// Fatal here rather than per entry. Inside another mutation every entry refuses
// for a reason that has nothing to do with the guard it names, and a refusal
// counts as a failure -- so a self-check that never ran would report that every
// entry behaved correctly. Refusing to start is the only answer that is not a
// wrong one.
if (process.env.AGENT_MESH_MUTATION_ACTIVE) {
  process.stderr.write("cannot run inside another mutation: nothing here would be measuring itself\n");
  process.exit(2);
}

interface Entry extends Mutation {
  /** What broke, in the past tense, because it happened. */
  defect: string;
  /** Minutes, roughly: does this stand up a mesh? */
  slow?: boolean;
}

const RUNNER = "e2e/scenario-runner.ts";
const SCOPE = "test/typecheck-scope.test.ts";
const scenario = (id: string) => ["bun", RUNNER, id];
const scopeTest = ["bun", "test", SCOPE];
const typecheck = ["bun", "run", "check"];

type Outcome = "caught" | "NOT CAUGHT" | "REFUSED";

const MUTATIONS: Entry[] = [
  {
    defect:
      "`tsconfig.json` covered src and test only, so `bun run check` never opened e2e, scripts or .claude/hooks while reporting zero errors for changes made in them.",
    file: "tsconfig.json",
    find: ', "e2e/**/*.ts"',
    replace: "",
    command: scopeTest,
  },
  {
    defect:
      "A pattern broad enough to cover a repository it has never seen makes the scope test pass on one nothing is compiled from.",
    file: "tsconfig.json",
    find: '"src/**/*.ts", "test/**/*.ts", "e2e/**/*.ts", "scripts/**/*.ts", ".claude/hooks/**/*.ts"',
    replace: '"**/*.ts"',
    command: scopeTest,
  },
  {
    defect:
      "The other half of the same collapse: a file list that finds nothing is trivially inside any scope. A hand-written ignore list could empty it one name at a time.",
    file: SCOPE,
    find: '"--exclude-standard", "*.ts"',
    replace: '"--exclude-standard", "src/*.ts"',
    command: scopeTest,
  },
  {
    defect:
      "The platform's runner had a switch with no default, so an unknown verb ran nothing and the scenario reported green -- in the file citing the clause that forbids it. Here the guard existed but was typed loosely enough to be decoration.",
    file: RUNNER,
    find: '    case "sleep":',
    replace: '    case "never-emitted":',
    command: typecheck,
  },
  {
    defect:
      "`provision` and `http` each had their own copy of the expectation check on the platform side; only one learned about `body`, so every body assertion on a provision step was green without being checked.",
    file: RUNNER,
    find: "substitute(loose.expect.body, bindings)",
    replace: "loose.expect.body",
    command: scenario("E2E-KEY-003"),
    slow: true,
  },
  {
    defect:
      "An unresolved `{{taken}}` sent verbatim makes `DELETE /api/v1/outbox/{{taken}}` answer 404 -- the status a later step legitimately expects -- so a missing binding reads as the scenario passing.",
    file: RUNNER,
    find: "Object.entries(bind ?? {})",
    replace: "Object.entries({} as Record<string, string>)",
    command: scenario("E2E-RECALL-001"),
    slow: true,
  },
  {
    defect:
      "Until `as: { signedBy }` existed, the signed REST surface was unreachable from any scenario, and the client's own preimage bug there had never been executed.",
    file: RUNNER,
    find: "signer ?? null,",
    replace: "null,",
    command: scenario("E2E-RECALL-001"),
    slow: true,
  },
  {
    defect:
      "Three clauses are asserted through operator routes that only answer correctly because of their query string; a runner dropping it would leave them checking a status code.\n" +
      "            Corrupts the filter values rather than removing the query, which the first version did. Removing it depends on some other row being first, and running this scenario alone gives it a mesh where its own row is first — so the guard passed against a runner that had stopped filtering. It was already flaky when committed, and said so in this very description.",
    file: RUNNER,
    find: "`${base}${path}`",
    replace: '`${base}${path.replace(/=[^&]*/g, "=no-such-value")}`',
    command: scenario("E2E-SOURCE-001"),
    slow: true,
  },
  {
    defect:
      "A mesh requirement asked for but not honoured leaves E2E-RECEIVE-002 passing without ever reaching the lapse it exists to show.",
    file: RUNNER,
    find: "String(requirement.receiveLeaseSeconds)]",
    replace: "String(3)]",
    command: scenario("E2E-CAP-001"),
    slow: true,
  },
];

/**
 * Two mutations that must **not** be caught, for `--self-check`.
 *
 * The failure branch of this file had never executed. A set of nine that all
 * pass never prints `NOT CAUGHT`, so the code saying a guard is missing was
 * itself a check nobody had seen work -- this file appearing inside the tool
 * written to find it.
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
  },
  {
    defect: "TEMPORARY: a pattern that is no longer present, as a rename would leave it.",
    mustFailAs: "REFUSED",
    file: SCOPE,
    find: "a-string-this-file-does-not-contain",
    replace: "irrelevant",
    command: scopeTest,
  },
];

async function evaluate(entry: Entry): Promise<{ outcome: Outcome; detail: string }> {
  try {
    const exitCode = await runMutation(entry);
    return exitCode === 0
      ? { outcome: "NOT CAUGHT", detail: entry.defect }
      : { outcome: "caught", detail: "" };
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

const fast = process.argv.includes("--fast");
const selected = fast ? MUTATIONS.filter((entry) => !entry.slow) : MUTATIONS;
if (fast) {
  // Said out loud. A partial run reported as a full one is the same shape as
  // everything else in this file.
  process.stdout.write(`skipping ${MUTATIONS.length - selected.length} mesh-backed mutation(s)\n\n`);
}

let missed = 0;
for (const [index, entry] of selected.entries()) {
  const label = `${index + 1}/${selected.length} ${entry.file} ${entry.command.slice(1).join(" ")}`;
  const { outcome, detail } = await evaluate(entry);
  if (outcome !== "caught") missed += 1;
  process.stdout.write(
    outcome === "caught" ? `caught      ${label}\n` : `${outcome.padEnd(11)} ${label}\n            ${detail}\n`,
  );
}

process.stdout.write(`\n${selected.length - missed}/${selected.length} caught\n`);
process.exit(missed === 0 ? 0 : 1);
