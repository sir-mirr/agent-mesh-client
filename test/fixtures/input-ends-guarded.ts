// The guard under test, in the state every TUI screen puts the terminal in.
import { exitWhenInputEnds } from "../../src/tui/app";

exitWhenInputEnds();
if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
// What `selectGrid` does: park on a promise only a keypress can settle.
await new Promise(() => {});
