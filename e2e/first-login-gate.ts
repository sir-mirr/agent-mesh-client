/**
 * A first login that must change its password can do that and nothing else.
 *
 * The platform's seeded admin briefly answered 403 on every route but three
 * until its password was changed, and key approval was outside those three:
 * fourteen of eighteen scenarios failed on `approve` with a message about
 * passwords. The platform then seeded the account as already-changed, so the
 * gate is down again.
 *
 * This stays because the runner drives a checkout it does not own. It costs one
 * GET when the gate is absent, and the alternative is fourteen red scenarios
 * whose message names key approval.
 *
 * It lives in its own file so it can be exercised. Left inside the runner it
 * would be a branch that runs only against a platform build that no longer
 * exists -- written, asserted, and never executed, which is the shape it was
 * added to catch.
 */

export interface GateOutcome {
  /** Was the gate actually set? */
  gated: boolean;
  /** What the password route answered, when it was called. */
  status?: number;
}

export async function passFirstLoginGate(
  origin: string,
  cookie: string,
  current: string,
  next: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GateOutcome> {
  const me = await fetchImpl(`${origin}/auth/me`, {
    headers: { cookie },
    signal: AbortSignal.timeout(15_000),
  });
  const session = await me.json().catch(() => null);
  // Asked before it is done: a mesh without the gate is left alone rather than
  // having its password changed by a test run.
  if (!session?.must_change_password) return { gated: false };
  const changed = await fetchImpl(`${origin}/auth/local/password`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ current, next }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!changed.ok) {
    throw new Error(
      `admin password change returned HTTP ${changed.status}: ${(await changed.text()).slice(0, 200)}`,
    );
  }
  return { gated: true, status: changed.status };
}
