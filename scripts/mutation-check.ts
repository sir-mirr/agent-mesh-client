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
      "The CLI held its own copy of the version. package.json said the same string and the git tag said a third, so the v0.1.1 release shipped a binary reporting `0.1.0-dev.0` — a version matching no tag anyone could install, with nothing comparing the two.",
    file: "src/cli.ts",
    find: "const VERSION = packageManifest.version;",
    replace: 'const VERSION = "0.1.0-dev.0";',
    command: ["bun", "test", "test/version-source.test.ts"],
    evidence: "reported version > the CLI reads it rather than repeating it",
  },
  {
    defect:
      "The tag-to-version step accepted any ref. A branch or a manual dispatch would be written into the manifest verbatim, producing a binary that answers `main`.",
    file: "scripts/set-version.ts",
    find: "/^v(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)$/",
    replace: "/^v?(.*)$/",
    command: ["bun", "test", "test/release-version.test.ts"],
    evidence: "release version injection > and anything that is not a tag is refused",
  },
  {
    defect:
      "With nothing selected this program printed `0/0 caught` and exited 0 — measured, not assumed. A green saying nothing ran, from the tool whose job is to say whether the checks check anything. The same shape appeared in three repositories the same night: `0 pass` cannot tell 'did not run' from 'all failed'.",
    file: "scripts/mutation-check.ts",
    find: "if (selected.length === 0) {",
    replace: "if (selected.length === -1) {",
    command: ["bun", "test", "test/empty-selection.test.ts"],
    evidence: "empty selection > a selection matching nothing is refused, not reported as a pass",
  },
  {
    defect:
      "Three agent-mesh TUIs were found on a development machine at 82 hours of CPU time each, spawned by an editor that had exited and left the far end of the pty closed. Every screen parks on a promise only a keypress settles, so the process did not block -- it burned a core, for days, and the released binary still does.",
    file: "src/tui/app.ts",
    find: "  exitWhenInputEnds();",
    replace: "",
    command: ["bun", "test", "test/input-ends.test.ts"],
    evidence: "terminal input ending > runTui installs it",
  },
  {
    defect:
      "`attach` opens a tmux session for every runtime and only the Claude supervisor ever killed one. Removing an Antigravity agent left `agy` running at 13.6% CPU in a session belonging to a lane that `lane list` no longer reported. Three strays were found on a development host, and the machine stopped running hot when they were closed.",
    file: "src/runtime/attach.ts",
    find: '  if (!hasSession(tmux, session)) return "absent";',
    replace: '  if (!hasSession(tmux, session)) return "closed";',
    command: ["bun", "test", "test/lane-session-release.test.ts"],
    evidence: "lane session release > and says so when there was nothing to close",
  },
  {
    defect:
      "install.sh is served off main by raw.githubusercontent, so an edit reaches every user with no tag and no build. Nothing in .github executed it -- its only mention there was the sentence in the release notes telling people to run it, and the first person to actually run it found it by hand.",
    file: ".github/workflows/ci.yml",
    find: "sh install.sh",
    replace: "true",
    command: ["bun", "test", "test/installer-coverage.test.ts"],
    evidence: "installer coverage > ci runs the installer on every push",
  },
  {
    defect:
      "The runner's handling of the first-login password gate ran against a platform build that no longer exists: the platform seeded the account as already-changed an hour after adding the gate. Written, asserted, and executed by nothing — which is the shape it was added to catch.",
    file: "e2e/first-login-gate.ts",
    find: "  if (!session?.must_change_password) return { gated: false };",
    replace: "  if (session) return { gated: false };",
    command: ["bun", "test", "test/first-login-gate.test.ts"],
    evidence: "first login password gate > changes the password when the gate is set, with the credentials given",
  },
  {
    defect:
      "The Hub consumes a nonce before it verifies the signature (SPEC 8.1), so a request that failed on its signature has still spent it. A client that retries with the same nonce fails again for a different reason under the same error code and cannot tell them apart — it retries forever. Nothing on either side measured this.",
    file: "src/identity/key-manager.ts",
    find: "    const nonce = prefixedId(\"nonce\");",
    replace: "    const nonce = \"nonce_replayed_every_time\";",
    command: ["bun", "test", "test/nonce-freshness.test.ts"],
    evidence: "nonce freshness > signing the same request twice produces different nonces and signatures",
  },
  {
    defect:
      "The runner spawned the harness from the platform author's working tree. Over one evening that tree was two behind with two files modified, then clean and one ahead, then two behind again — and one run caught it mid-mutation and reported 10/18 failing on signatures, a defect present in no commit. Aligning a checkout someone else pointed at would be the same mistake with the write turned on.",
    file: "e2e/platform-checkout.ts",
    find: '  return override === undefined || override === "";',
    replace: "  return true;",
    command: ["bun", "test", "test/platform-checkout.test.ts"],
    evidence: "platform checkout > and a checkout someone pointed at is never moved",
  },
  {
    defect:
      "A pipeline reports the last command's status, not the failing one. `gh run watch | tail` then `$?` reads tail, and tail succeeds at printing a failure — a red CI run was nearly reported as green here. GitHub's default shell is `bash -e` without pipefail, so a run block with a pipe can pass while the interesting half failed.",
    file: ".github/workflows/release.yml",
    find: "          set -euo pipefail\n          gh release download",
    replace: "          gh release download",
    command: ["bun", "test", "test/pipefail.test.ts"],
    evidence: "pipefail > every run block with a pipeline sets pipefail",
  },
  {
    defect:
      "The summary divided by the number of scenarios that produced a result, while the work iterated the selected list. A scenario dropped between the plan and the tally would print `17/17 contract scenarios` — a complete pass of a set one short. A sweep on the platform side hit exactly this: its summary array was shadowed by a variable already in scope, so it read an empty array and reported zero of zero while the work had been done.",
    file: "e2e/scenario-tally.ts",
    find: "  if (planned === recorded) return null;",
    replace: "  return null;",
    command: ["bun", "test", "test/scenario-tally.test.ts"],
    evidence: "scenario tally > a scenario that produced no result is refused, not divided away",
  },
  {
    defect:
      "Three tests filtered the channel error codes and expected nothing left. An empty enumeration satisfies all three, and the suite would report the namespace boundary held while comparing no codes. Measured next door the same night: a sweep reported zero dropped fields across fourteen screens, and adjudications rose 13 to 32 once data existed — same code, same tool, nothing to look at.",
    file: "src/constants.ts",
    find: "  NOT_REGISTERED: -32050,",
    replace: "  NOT_REGISTERED: -32014,",
    command: ["bun", "test", "test/error-namespaces.test.ts"],
    evidence: "channel and mesh error namespaces > shares no number with a live or retired mesh code",
  },
  {
    defect:
      "Stripping whole comment lines stopped an assertion being satisfied by the comment above a step. A comment on the end of a line survived it: `- run: echo hi  # scripts/set-version.ts` satisfied both a contains check and a regex anchored on `run:` — measured, both true. The platform hit the mirror image the same night, treating a string that held a comment opener as a comment and hiding a hundred lines.",
    file: "test/support/code-only.ts",
    find: "      const at = line.indexOf(` ${marker}`);",
    replace: "      const at = -1;",
    command: ["bun", "test", "test/code-only.test.ts"],
    evidence: "code only > a trailing comment cannot satisfy an assertion about the line",
  },
  {
    defect:
      "Whether a run asked its questions of changed code was decided by reading commit titles — a prediction dressed as a measurement. Eleven runs reported 18/18; measuring the diffs showed eight of them touched nothing the scenarios reach. Counting those as coverage overstates it, and a surface matcher that says yes to everything erases the distinction entirely.",
    file: "scripts/contract-surface.ts",
    find: 'const NOT_SURFACE = [/^packages\\/http\\/src\\/ui\\//];',
    replace: "const NOT_SURFACE: RegExp[] = [];",
    command: ["bun", "test", "test/contract-surface.test.ts"],
    evidence: "contract surface > and screens, docs and scripts are not",
  },
  {
    defect:
      "The surface metric counted the platform's own test files. A range reported `surface 2` where one of the two was `main.in-process.test.ts` — saying a run might have asked something of changed code when half of what changed was the platform checking itself. The metric already over-counts; this was over-counting in a way that named the wrong thing.",
    file: "scripts/contract-surface.ts",
    find: "  /\\.test\\.ts$/,",
    replace: "",
    command: ["bun", "test", "test/contract-surface.test.ts"],
    evidence: "contract surface > and a test file is not code a scenario reaches",
  },
  {
    defect:
      "Listening was not the fix. An `end` handler that returns instead of leaving measured 90.1% CPU -- the same spin, now with a handler in the file to suggest otherwise.",
    file: "src/tui/app.ts",
    find: "    process.exit(2);",
    replace: "    return;",
    command: ["bun", "test", "test/input-ends.test.ts"],
    evidence: "terminal input ending > the TUI leaves when the terminal closes",
  },
  {
    defect:
      "The injection is only reached because the workflow calls it. A workflow that stopped calling it would leave every test about the injection passing while releases went back to shipping whatever the manifest said — which is exactly how v0.1.1 shipped.",
    file: ".github/workflows/release.yml",
    find: "- run: bun run scripts/set-version.ts",
    replace: "- run: echo no version injection",
    command: ["bun", "test", "test/release-version.test.ts"],
    evidence: "release version injection > the release workflow calls this and holds no version logic of its own",
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
    find: "  const step = substitute(raw, bindings);",
    replace: "  const step = raw;",
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
      "Substitution enumerated the three places the contract names, and the vocabulary grew a fourth: E2E-REPLY-001 puts `{{mailId}}` in `replyTo`. The literal reached the hub, a reply looked like an ordinary send, the push that produced failed the scenario, and the failure pointed at the hub.",
    file: RUNNER,
    find: "  const step = substitute(raw, bindings);",
    replace: "  const step = raw;",
    command: scenario("E2E-REPLY-001"),
    slow: true,
    evidence: "expected 0 push(es) since the last check, got 1",
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
      "The hub pushes what accumulated while an identity was away, on connect. A lane that only listens -- this client never calls mesh.receive -- has no other way to see it, and until v0.21.0 nothing stated the guarantee.",
    file: RUNNER,
    find: 'if (message.method === "mesh.message") delivered += 1;',
    replace: "// counted nothing",
    command: scenario("E2E-CONNECT-001"),
    slow: true,
    evidence: "expected 1 pushed message(s) after connect, got 0",
  },
  {
    defect:
      "A non-2xx with a body that is not JSON-RPC shaped read as success: a 404 saying \"Not Found\" has neither `ok: false` nor an `error`, so a send against a renamed route passed and the scenario failed two steps later on a message never sent. That is exactly what the mailbox split produced.",
    file: RUNNER,
    find: '"POST", "/api/v1/mailbox/out"',
    replace: '"POST", "/api/v1/outbox"',
    command: scenario("E2E-CONNECT-001"),
    slow: true,
    evidence: 'expected success, got error {"code":404,"message":"Not Found"}',
  },
  {
    defect:
      "The harness is spawned from the platform checkout, so a run against a dirty tree measures code in no commit. A run reported 10/18 with SIGNATURE_INVALID everywhere, minutes after 18/18 on the same commit, because the other side was mid-mutation in that tree. Reporting it as a contract mismatch would have sent someone after a defect that exists nowhere.",
    file: "e2e/dirty-tree.ts",
    find: 'const isDirty = dirty === true || dirty === "true";',
    replace: "const isDirty = dirty === true;",
    command: ["bun", "test", "test/dirty-tree.test.ts"],
    evidence: "scenario runs refuse a dirty platform checkout",
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
