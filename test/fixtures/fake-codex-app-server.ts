#!/usr/bin/env bun
import { createInterface } from "node:readline";

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line) as {
    id?: number;
    method: string;
    params?: Record<string, unknown>;
  };
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    write({ id: request.id, result: { userAgent: "fake" } });
  } else if (request.method === "thread/start") {
    write({ id: request.id, result: { thread: { id: "thread-fake" } } });
  } else if (request.method === "thread/resume") {
    write({
      id: request.id,
      result: { thread: { id: request.params?.threadId ?? "thread-fake" } },
    });
  } else if (request.method === "turn/start") {
    write({ id: request.id, result: { turn: { id: "turn-fake" } } });
    write({
      method: "item/completed",
      params: {
        threadId: request.params?.threadId,
        turnId: "turn-fake",
        item: { type: "agentMessage", id: "item-fake", text: "fake codex reply" },
      },
    });
    write({
      method: "turn/completed",
      params: {
        threadId: request.params?.threadId,
        turn: {
          id: "turn-fake",
          status: "completed",
          error: null,
          items: [
            { type: "agentMessage", id: "item-fake", text: "fake codex reply" },
          ],
        },
      },
    });
  } else if (request.method === "turn/interrupt") {
    write({ id: request.id, result: {} });
  } else {
    write({ id: request.id, error: { code: -32601, message: "not found" } });
  }
});
