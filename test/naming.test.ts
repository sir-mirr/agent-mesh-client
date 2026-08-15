import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Every method that writes must be named for writing.
 *
 * This repository already had the habit -- `record`, `mark*`, `claim*`,
 * `reserve*`, `complete*` -- and a query-named writer would have looked wrong
 * next to them. A habit is not a guard: it holds while the people who have it
 * are the ones writing, and the defect it prevents is invisible afterwards
 * because the name reads as a question and the answer looks right.
 *
 * The rule is stated as "writers are named for it" rather than "queries must
 * not write". Both catch `getFoo` doing an UPDATE; only this one catches a
 * direct writer called `process`, `sync` or `apply`, and nobody sets out to
 * name a mutation `get`.
 *
 * **What it cannot see**: a write one call deep. Renaming `markRetry` to
 * `processRetry` passes this rule, because that method delegates to
 * `#transition` and holds no write of its own -- checked, not assumed. Only
 * the method the SQL is written in is covered.
 *
 * Following calls would mean resolving them, and then every caller of a writer
 * would have to be named for writing too -- which is false: `#process` in the
 * audit worker legitimately drives `markAcked`. So this holds the layer where
 * the SQL and the filesystem are, and the layer above stays a review question.
 * Stating the blind spot beats implying there is none.
 *
 * Verified by mutation, since a naming rule that catches nothing also passes:
 *   markAcked -> getAcked                 caught
 *   #transition -> #processTransition     caught
 *   markRetry -> processRetry             NOT caught (delegates; the blind spot)
 */

const MUTATING = [
  "record", "mark", "claim", "reserve", "complete", "ensure", "set", "save",
  "write", "add", "remove", "delete", "insert", "update", "replay", "put",
  "initialize", "migrate", "close", "stop", "start", "reload", "register",
  "enqueue", "clear", "prune", "release", "fail", "poke", "attach", "detach",
  "provision", "rotate", "sync", "apply", "run", "send", "emit", "handle",
  // Added only after checking each one is a mutating verb in its own right,
  // not to quiet the list: a transition is applied, a conversation is reset,
  // a blob is ingested.
  "transition", "reset", "ingest",
];

/** Lines that put a row or a file somewhere it outlives this process. */
const WRITE_PATTERNS = [
  /\.run\(/,
  /\bwriteFile\(/,
  /\brename\(/,
  /\bunlink\(/,
  /\bmkdir\(/,
  /\bexec\(/,
];

interface Method {
  file: string;
  name: string;
  line: number;
  body: string[];
}

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

/**
 * Class members at two-space indentation, with everything up to the next
 * member as the body. Good enough because the formatting is uniform, and a
 * parser that missed a method would fail open -- so the assertion below also
 * checks that the scan found the methods it is supposed to.
 */
function methodsIn(file: string, source: string): Method[] {
  const lines = source.split("\n");
  const header = /^ {2}(?:(?:async|readonly|static|get|set) )*(#?[A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\(/;
  const methods: Method[] = [];
  let current: Method | null = null;
  for (const [index, line] of lines.entries()) {
    const match = header.exec(line);
    if (match) {
      current = { file, name: match[1]!, line: index + 1, body: [] };
      methods.push(current);
      continue;
    }
    // A closing brace at member indentation ends the member.
    if (/^ {2}\}/.test(line)) current = null;
    else current?.body.push(line);
  }
  return methods;
}

function writes(method: Method): boolean {
  return method.body.some((line) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return false;
    return WRITE_PATTERNS.some((pattern) => pattern.test(line));
  });
}

function namedForWriting(name: string): boolean {
  const bare = name.replace(/^#/, "").toLowerCase();
  return MUTATING.some((verb) => bare.startsWith(verb));
}

const methods = (
  await Promise.all(
    (await sourceFiles("src")).map(async (file) => methodsIn(file, await readFile(file, "utf8"))),
  )
).flat();

describe("methods that write are named for it", () => {
  test("the scan actually found the class members", () => {
    // A regex that stopped matching would make every assertion below vacuous.
    const names = new Set(methods.map((method) => method.name));
    expect(names.has("markAcked")).toBe(true);
    expect(names.has("claimNext")).toBe(true);
    expect(names.has("peek")).toBe(true);
    expect(methods.length).toBeGreaterThan(100);
  });

  test("no method writes under a name that does not say so", () => {
    const offenders = methods
      .filter((method) => writes(method) && !namedForWriting(method.name))
      .map((method) => `${method.file}:${method.line} ${method.name}`)
      .sort();
    expect(offenders).toEqual([]);
  });

  // The pair that made this rule: one looks, one takes, and the difference is
  // in the name because it cannot be anywhere else.
  test("keeps the reading and taking halves of the inbox apart", () => {
    const inbox = methods.filter((method) => method.file.endsWith("runtime/inbox.ts"));
    const next = inbox.find((method) => method.name === "next");
    const claimNext = inbox.find((method) => method.name === "claimNext");
    expect(writes(next!)).toBe(false);
    expect(writes(claimNext!)).toBe(true);
  });
});
