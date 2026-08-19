export {};

// The same program without the guard. Without this the test above would pass
// against a binary that exits for some unrelated reason -- this one has to be
// still running when the guarded one has already left.
if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
await new Promise(() => {});
