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
      "Three clauses were asserted only through a status code once `expectStored` was removed; without the query string the operator routes answer with whatever row is first.",
    file: RUNNER,
    find: "`${base}${path}`",
    replace: '`${base}${path.split("?")[0]}`',
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
  try {
    const exitCode = await runMutation(entry);
    if (exitCode === 0) {
      missed += 1;
      process.stdout.write(`NOT CAUGHT  ${label}\n            ${entry.defect}\n`);
    } else {
      process.stdout.write(`caught      ${label}\n`);
    }
  } catch (error) {
    // A refusal is not a result. Counting it as caught would let a mutation
    // that stopped matching -- a rename, a rewrite -- report success forever.
    missed += 1;
    process.stdout.write(
      `REFUSED     ${label}\n            ${error instanceof MutationRefused ? error.message : String(error)}\n`,
    );
  }
}

process.stdout.write(`\n${selected.length - missed}/${selected.length} caught\n`);
process.exit(missed === 0 ? 0 : 1);
