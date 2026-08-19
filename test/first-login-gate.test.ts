import { describe, expect, test } from "bun:test";
import { passFirstLoginGate } from "../e2e/first-login-gate";

/**
 * The branch that fourteen scenarios needed for about an hour.
 *
 * The platform's seeded admin had to change its password before it could do
 * anything else; key approval was outside the three routes that stayed open.
 * The platform then seeded the account as already-changed, which means the
 * runner's handling of the gate now runs against no platform build at all --
 * so a real server is stood up here that still has it.
 */
function fakeHub(gated: boolean, passwordStatus = 200) {
  const seen: { path: string; body?: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/auth/me") {
        seen.push({ path: url.pathname });
        return Response.json({ must_change_password: gated });
      }
      if (url.pathname === "/auth/local/password") {
        seen.push({ path: url.pathname, body: await request.json() });
        return new Response("denied", { status: passwordStatus });
      }
      return new Response("no", { status: 404 });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
}

describe("first login password gate", () => {
  test("changes the password when the gate is set, with the credentials given", async () => {
    const hub = fakeHub(true);
    try {
      const outcome = await passFirstLoginGate(hub.origin, "mesh_token=t", "admin", "e2e-runner-password");
      expect(outcome).toEqual({ gated: true, status: 200 });
      expect(hub.seen.map((call) => call.path)).toEqual(["/auth/me", "/auth/local/password"]);
      expect(hub.seen[1]!.body).toEqual({ current: "admin", next: "e2e-runner-password" });
    } finally {
      hub.stop();
    }
  });

  // The control. A function that always POSTs would satisfy the case above and
  // would change the password of every mesh the runner touches.
  test("and leaves a mesh without the gate alone", async () => {
    const hub = fakeHub(false);
    try {
      expect(await passFirstLoginGate(hub.origin, "mesh_token=t", "admin", "e2e-runner-password"))
        .toEqual({ gated: false });
      expect(hub.seen.map((call) => call.path)).toEqual(["/auth/me"]);
    } finally {
      hub.stop();
    }
  });

  // A refused change has to be loud. Swallowed, the run would continue and fail
  // later on `approve` -- which is exactly the message that sent this to the
  // wrong place the first time.
  test("and says so when the change is refused", async () => {
    const hub = fakeHub(true, 400);
    try {
      await expect(
        passFirstLoginGate(hub.origin, "mesh_token=t", "admin", "short"),
      ).rejects.toThrow(/HTTP 400/);
    } finally {
      hub.stop();
    }
  });
});
