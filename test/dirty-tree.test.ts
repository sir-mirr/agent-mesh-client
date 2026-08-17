import { describe, expect, test } from "bun:test";
import { refusesDirtyTree } from "../e2e/dirty-tree";

describe("scenario runs refuse a dirty platform checkout", () => {
  test("refuses when the harness reports uncommitted changes", () => {
    expect(refusesDirtyTree({ dirty: true, override: undefined })).toBe(true);
    // The ready file is JSON and has carried the string form. Reading only the
    // boolean would answer "clean" for a tree it simply could not parse.
    expect(refusesDirtyTree({ dirty: "true", override: undefined })).toBe(true);
  });

  test("proceeds on a clean tree", () => {
    expect(refusesDirtyTree({ dirty: false, override: undefined })).toBe(false);
    expect(refusesDirtyTree({ dirty: "false", override: undefined })).toBe(false);
    // Absent is not dirty: a checkout with no `.git` reports `unknown`, and a
    // tarball run is legitimate rather than suspect.
    expect(refusesDirtyTree({ dirty: undefined, override: undefined })).toBe(false);
  });

  test("the override is exact, so a stray value does not disable the guard", () => {
    expect(refusesDirtyTree({ dirty: true, override: "1" })).toBe(false);
    // `"0"`, `"false"`, `"yes"` all mean "not the opt-in". A truthiness check
    // here would let any value at all through, which is how an escape hatch
    // becomes the default without anyone choosing it.
    expect(refusesDirtyTree({ dirty: true, override: "0" })).toBe(true);
    expect(refusesDirtyTree({ dirty: true, override: "false" })).toBe(true);
    expect(refusesDirtyTree({ dirty: true, override: "" })).toBe(true);
  });
});
