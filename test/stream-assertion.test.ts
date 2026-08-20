import { describe, expect, test } from "bun:test";
import { codeOnly } from "./support/code-only";

/**
 * What a stream assertion is allowed to be satisfied by.
 *
 * `{ streaming: true }` meant one thing: the body had not ended after two
 * seconds. A route answering `application/json` with an open body that
 * published nothing forever satisfied it, so a scenario asserting it was
 * asserting a timeout rather than a stream. These serve the two shapes and
 * check that the runner can tell them apart.
 */
async function serve(handler: (request: Request) => Response): Promise<{ url: string; stop: () => void }> {
  // idleTimeout 0: these fixtures are meant to hold a request open, and the
  // default ten-second server-side timeout would end it for them.
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: handler });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

function sse(firstFrame: string): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(firstFrame));
      // Never closed: this is the shape that made reading to the end hang.
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

/**
 * Open, declared as JSON, publishing something that is not an event frame --
 * the impostor `streaming: true` alone accepts.
 *
 * A fixture that emits *nothing* was the first draft and is not reachable: Bun
 * does not flush the response headers until the first chunk, so `fetch` never
 * resolves and no check, old or new, ever sees it. The impostor that matters is
 * a body that answers, keeps the connection, and is not a stream.
 */
function openButNotAStream(): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial":true}'));
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/json" } });
}

// One reader and no `response.text()`, the same shape the runner uses. `text()`
// takes the body lock and keeps it whether or not it ever resolves, so a later
// `getReader()` throws and a later `cancel()` never settles -- both measured,
// and both are why this helper is written this way rather than the obvious way.
// 300ms rather than the runner's 2s: what is under test is that the content
// type and the opening frame tell a stream from a hang.
async function observe(url: string): Promise<{ contentType: string | null; firstFrame: string | null }> {
  const response = await fetch(url);
  const reader = response.body!.getReader();
  const chunk = await Promise.race([
    reader.read(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 300)),
  ]);
  void reader.cancel();
  return {
    contentType: response.headers.get("content-type"),
    firstFrame: chunk && !chunk.done && chunk.value ? new TextDecoder().decode(chunk.value) : null,
  };
}

describe("stream assertion", () => {
  test("a real stream reports its content type and its opening frame", async () => {
    const server = await serve(() => sse('event: connected\ndata: {"agent":"e2e-streamer"}\n\n'));
    try {
      const seen = await observe(server.url);
      expect(seen.contentType).toBe("text/event-stream");
      expect(seen.firstFrame).toContain("e2e-streamer");
    } finally {
      server.stop();
    }
  });

  // The control that gives the test above its meaning. Both bodies stay open,
  // so "it did not end" cannot tell them apart -- only the declared type and
  // what the first frame actually says can.
  test("and an open body that is not a stream is distinguishable from it", async () => {
    const server = await serve(() => openButNotAStream());
    try {
      const seen = await observe(server.url);
      expect(seen.contentType).toBe("application/json");
      expect(seen.firstFrame).not.toContain("event:");
      expect(seen.firstFrame).not.toContain("e2e-streamer");
    } finally {
      server.stop();
    }
  });

  test("the runner reports both facts, not only that it did not end", async () => {
    const source = codeOnly(await Bun.file("e2e/scenario-runner.ts").text(), "slash");
    expect(source).toContain("content_type: response.headers.get(\"content-type\")");
    expect(source).toContain("first_frame: observed.firstFrame");
    // And lets the stream go: on the platform side the request's abort signal
    // is the only cleanup an SSE client gets.
    expect(source).toContain("reader.cancel()");
    // Never `text()` on a body that may not end: it takes the lock and keeps
    // it, so everything after it either throws or hangs. Scoped to the reader
    // rather than the whole file -- `text()` on an ordinary error response,
    // which is where the other call is, is fine.
    const from = source.indexOf("async function readBounded");
    const to = source.indexOf("\n}\n", from);
    expect(from).toBeGreaterThan(-1);
    expect(source.slice(from, to)).not.toContain(".text()");
  });
});
