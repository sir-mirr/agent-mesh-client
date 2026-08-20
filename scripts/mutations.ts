#!/usr/bin/env bun
/**
 * The mutations, on their own so something other than the runner can read them.
 *
 * They lived inside `mutation-check.ts`, which is a script: importing it ran a
 * whole mutation round and exited the process. That made the set unreadable to
 * a test -- and the test that wants it is the one asking whether any of these
 * mutations is sitting in the committed source, which is a question about the
 * repository rather than about a run.
 *
 * A neighbouring repository had a mutation on `main` for three days with an
 * authentication guard deleted, inside a commit about something else. Their
 * tool kept one backup slot; ours keeps none and restores with `git checkout`.
 * But the durable guard is not a property of a tool: it reads what was
 * committed, and for that it needs the list.
 */

import type { Mutation } from "./mutate";

export interface Entry extends Mutation {
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

export const RUNNER = "e2e/scenario-runner.ts";
export const SCOPE = "test/typecheck-scope.test.ts";
export const scenario = (id: string) => ["bun", RUNNER, id];
export const scopeTest = ["bun", "test", SCOPE];
export const typecheck = ["bun", "run", "check"];

const CONTRACT_PIN = (
  JSON.parse(await Bun.file("package.json").text()) as { dependencies: Record<string, string> }
).dependencies["@agent-mesh/contracts"]!.match(/#v(\d+\.\d+\.\d+)/)?.[1];
if (!CONTRACT_PIN) throw new Error("package.json does not pin @agent-mesh/contracts to a tag");

export const MUTATIONS: Entry[] = [
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
    find: "  /^packages\\/http\\/src\\/ui\\//,",
    replace: "",
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
  {
    defect:
      "Two copies of the same twelve-line sleep lived in the hub loops, one releasing its abort listener and one not. The leaking copy runs once a second for the life of a lane, so it held one listener per second of uptime -- unbounded, permanently retained, and invisible in RSS because the list lives native-side. Found by five independent readers hunting a CPU ramp; all five refuted it as the cause and all five confirmed the leak.",
    file: "src/util/abortable-sleep.ts",
    find: '      signal.removeEventListener("abort", onAbort);\n',
    replace: "",
    command: ["bun", "test", "test/abortable-sleep.test.ts"],
    evidence: "the timer winning releases the abort listener, every pass",
  },
  {
    defect:
      "A meter nothing calls reports zeroes, and zeroes are what a healthy idle daemon looks like. The delivery loop losing its counter would leave `daemon status` answering that the loop never ran -- the same reading it gives for a loop that genuinely never ran.",
    file: "src/daemon/agent-mesh-daemon.ts",
    find: '    loopMeter.countPass("delivery");\n',
    replace: "",
    command: ["bun", "test", "test/loop-meter.test.ts"],
    evidence: "all three one-second loops count their passes",
  },
  {
    defect:
      "Two scenarios sharing an id both get selected, both run and both report, so the tally that guards the count sees a perfect run. `--only` on that id then runs two unrelated scenarios. E2E-AUTH-KEYSTREAM-002 was used twice here and the platform side found it, because nothing on this side could.",
    file: "e2e/scenario-runner.ts",
    find: "const duplicated = duplicateIds(E2E_SCENARIOS);",
    replace: "const duplicated: string[] = [];",
    command: ["bun", "test", "test/scenario-ids.test.ts"],
    evidence: "the runner refuses before it selects",
  },
  {
    defect:
      "`streaming: true` meant only that the body had not ended after two seconds. No byte was read and no header was looked at, so a route answering `application/json` over a connection it simply kept open satisfied a stream assertion. Worse, the first version raced `response.text()`, which takes the body lock and keeps it: the `getReader()` after it threw and the `cancel()` after it never settled. Nothing in the set asserts a streaming route at 200, so that path had never run.",
    file: "e2e/scenario-runner.ts",
    find: '          content_type: response.headers.get("content-type"),\n          first_frame: observed.firstFrame,\n',
    replace: "",
    command: ["bun", "test", "test/stream-assertion.test.ts"],
    evidence: "the runner reports both facts, not only that it did not end",
  },
];
