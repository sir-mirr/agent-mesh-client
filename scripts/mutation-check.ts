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
  /**
   * What the mutated run must print for its exit code to be a verdict.
   *
   * Names the check that fired, not merely that something did. A summary line
   * or a scenario id appears whether the assertion caught the mutation or the
   * mesh refused to start, so a run that never reached the check was recorded
   * as the guard working -- which happened here to the lease entry.
   *
   * **Collected, never predicted.** Every string below came from running the
   * mutation and reading what it said. A predicted message is a copy of a
   * format that lives in another file; a collected one still copies it, but
   * gets it wrong loudly on the next run rather than quietly.
   *
   * No step numbers: v0.18.0 inserted a step into E2E-AUDIT-001, and an
   * expectation anchored to `step 2` would have failed for a reason having
   * nothing to do with the guard it names.
   */
  evidence: string;
}

const RUNNER = "e2e/scenario-runner.ts";
const SCOPE = "test/typecheck-scope.test.ts";
const scenario = (id: string) => ["bun", RUNNER, id];
const scopeTest = ["bun", "test", SCOPE];
const typecheck = ["bun", "run", "check"];

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
const CONTRACT_PIN = (
  JSON.parse(await Bun.file("package.json").text()) as { dependencies: Record<string, string> }
).dependencies["@agent-mesh/contracts"]!.match(/#v(\d+\.\d+\.\d+)/)?.[1];
if (!CONTRACT_PIN) throw new Error("package.json does not pin @agent-mesh/contracts to a tag");

const MUTATIONS: Entry[] = [
  {
    defect:
      "Both READMEs stated the contract pin three tags behind, were corrected by hand, and drifted again within the hour. Nothing else in the repository reads those lines.",
    file: "package.json",
    find: `agent-mesh-contracts#v${CONTRACT_PIN}"`,
    replace: `agent-mesh-contracts#v${CONTRACT_PIN}9"`,
    command: ["bun", "test", "test/doc-pins.test.ts"],
    evidence: "documented contract pin > README.md states the installed version",
  },
  {
    defect:
      "`tsconfig.json` covered src and test only, so `bun run check` never opened e2e, scripts or .claude/hooks while reporting zero errors for changes made in them.",
    file: "tsconfig.json",
    find: ', "e2e/**/*.ts"',
    replace: "",
    command: scopeTest,
    evidence: "typecheck scope > covers every TypeScript file in the repository",
  },
  {
    defect:
      "A pattern broad enough to cover a repository it has never seen makes the scope test pass on one nothing is compiled from.",
    file: "tsconfig.json",
    find: '"src/**/*.ts", "test/**/*.ts", "e2e/**/*.ts", "scripts/**/*.ts", ".claude/hooks/**/*.ts"',
    replace: '"**/*.ts"',
    command: scopeTest,
    evidence: "typecheck scope > no include pattern covers the repository vacuously",
  },
  {
    defect:
      "The other half of the same collapse: a file list that finds nothing is trivially inside any scope. A hand-written ignore list could empty it one name at a time.",
    file: SCOPE,
    find: '"--exclude-standard", "*.ts"',
    replace: '"--exclude-standard", "src/*.ts"',
    command: scopeTest,
    evidence: "typecheck scope > the enumeration actually reaches the repository",
  },
  {
    defect:
      "The platform's runner had a switch with no default, so an unknown verb ran nothing and the scenario reported green -- in the file citing the clause that forbids it. Here the guard existed but was typed loosely enough to be decoration.",
    file: RUNNER,
    find: '    case "sleep":',
    replace: '    case "never-emitted":',
    command: typecheck,
    evidence: "is not assignable to type 'never'",
  },
  {
    defect:
      "`provision` and `http` each had their own copy of the expectation check on the platform side; only one learned about `body`, so every body assertion on a provision step was green without being checked.",
    file: RUNNER,
    find: "substitute(loose.expect.body, bindings)",
    replace: "loose.expect.body",
    command: scenario("E2E-KEY-003"),
    evidence: "expected key.fingerprint = \"{{fingerprint:e2e-restart}}\"",
    slow: true,
  },
  {
    defect:
      "An unresolved `{{taken}}` sent verbatim makes `DELETE /api/v1/outbox/{{taken}}` answer 404 -- the status a later step legitimately expects -- so a missing binding reads as the scenario passing.",
    file: RUNNER,
    find: "Object.entries(bind ?? {})",
    replace: "Object.entries({} as Record<string, string>)",
    command: scenario("E2E-RECALL-001"),
    evidence: "no binding for {{taken}}",
    slow: true,
  },
  {
    defect:
      "Until `as: { signedBy }` existed, the signed REST surface was unreachable from any scenario, and the client's own preimage bug there had never been executed.",
    file: RUNNER,
    find: "signer ?? null,",
    replace: "null,",
    command: scenario("E2E-RECALL-001"),
    evidence: "expected HTTP 409, got 401",
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
    evidence: "but the body has no sources.0.identity",
    slow: true,
  },
  {
    defect:
      "`null` in `expect.body` means absent or null -- how a scenario says a filter matched nothing, which is the only order-independent way to state it. Requiring the path to exist turns every such assertion into a failure against a correct route.",
    file: RUNNER,
    find: "    if (wanted === null) {",
    replace: "    if (false) {",
    command: scenario("E2E-AUDIT-001"),
    evidence: "but the body has no events.0",
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
    // Names the guard rather than the run. This one is caught before a
    // scenario executes -- the mesh refuses to start with a lease the scenario
    // did not ask for -- so there is no summary line, and the first full run
    // under the inconclusive rule correctly said so. The marker being the
    // refusal itself is stronger than a summary anyway: it says *which* check
    // fired, not merely that something did.
    evidence: "harness applied receive_lease_seconds=3, scenario requires 2",
  },
];

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
