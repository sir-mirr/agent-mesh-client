#!/usr/bin/env bun
const printIndex = process.argv.indexOf("--print");
if (printIndex < 0 || !process.argv[printIndex + 1]?.includes("[USER_MESSAGE")) {
  process.stderr.write("--print must be followed immediately by the prompt\n");
  process.exit(2);
}
const conversationIndex = process.argv.indexOf("--conversation");
const conversation =
  conversationIndex >= 0 ? process.argv[conversationIndex + 1] : "agy-fresh";
process.stdout.write(
  JSON.stringify({
    conversation_id: conversation,
    status: "SUCCESS",
    response: "fake antigravity reply",
    duration_seconds: 0.01,
    num_turns: 1,
    usage: { total_tokens: 1 },
  }),
);
