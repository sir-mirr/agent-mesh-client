// The guard under test, in the state every TUI screen puts the terminal in.
import { exitWhenInputEnds } from "../../src/tui/app";

const trace = process.env.AGENT_MESH_INPUT_TRACE;
// Recorded whether or not the guard fires, so a failure says which events the
// platform produced rather than only that the process was still running.
if (trace) {
  for (const event of ["end", "close", "error", "data"]) {
    process.stdin.on(event as "end", () => {
      Bun.write(`${trace}.seen`, `${event}\n`);
    });
  }
}
exitWhenInputEnds();
if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
// What `selectGrid` does: park on a promise only a keypress can settle.
await new Promise(() => {});
