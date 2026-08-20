/**
 * Which of the two servers answers a request.
 *
 * A mesh is two processes behind two base URLs, and a scenario names a path
 * without naming a server. The runner picked by path alone, against a list of
 * the hub's prefixes — which was right until a path turned out to be served by
 * *both*. `/api/v1/agents` is `POST` on the hub and `GET` on the http server,
 * and routing by path sent the `GET` to the hub, which answered
 * `405 method not allowed; use POST`. I read that as "the contract cannot
 * express this route" and reported it blocked. The platform side measured the
 * two dispatchers and showed the pair is already unique: the blocker was here.
 *
 * So the enumeration is by method *and* path. Same closed-set reasoning as
 * before — anything the hub does not claim belongs to the http server, because
 * a default of "hub" would silently send new admin routes to a server that has
 * never heard of them — only now the claim is precise enough to be true.
 *
 * Read from `packages/hub/src/main.ts`, which dispatches on `url.pathname` and
 * `req.method` in one place:
 *
 *   /api/v1/limits          any method
 *   /api/v1/mailbox*        any method
 *   /api/v1/capabilities    any method
 *   /api/v1/agents          POST only; anything else is 405
 *   /api/v1/agents/…/keys   GET only; a separate branch, and the one I missed
 *   /api/v1/rpc             POST only; anything else is 405
 */

interface HubRoute {
  /** Matched as the hub's own dispatcher matches it: `===` or `startsWith`. */
  exact?: boolean;
  prefix: string;
  /** Both must hold. `/api/v1/agents/{identity}/keys` is the only route here
   *  whose tail matters, and reading only the prefix put it on the wrong
   *  server. */
  suffix?: string;
  /** Absent means the hub answers this prefix whatever the method is. */
  method?: string;
}

const HUB_ROUTES: readonly HubRoute[] = [
  { prefix: "/api/v1/limits", exact: true },
  { prefix: "/api/v1/mailbox" },
  { prefix: "/api/v1/capabilities", exact: true },
  // Exact-match on the hub, POST only. The sub-path below is a *different*
  // branch there, and reading only the first cost a scenario: routing
  // `GET /api/v1/agents/{identity}/keys` by prefix alone sent it to the http
  // server, which answered 404. E2E-KEY-004 caught it. I had said this list was
  // "measured from the source" -- it was, from one branch of it.
  { prefix: "/api/v1/agents", exact: true, method: "POST" },
  { prefix: "/api/v1/agents/", suffix: "/keys", method: "GET" },
  { prefix: "/api/v1/rpc", exact: true, method: "POST" },
];

/**
 * True when the hub holds the *working* handler for this pair.
 *
 * Both servers claim some of the same paths, and the hub answers `405` on a
 * path it claims for another method. That is a refusal either way, so the
 * question worth answering is not "who claims it" but "who would actually do
 * the work" -- that is the server a scenario means when it names a path.
 */
export function hubServes(method: string, path: string): boolean {
  const bare = path.split("?")[0]!;
  return HUB_ROUTES.some(
    (route) =>
      (route.exact ? bare === route.prefix : path.startsWith(route.prefix)) &&
      (route.suffix === undefined || bare.endsWith(route.suffix)) &&
      (route.method === undefined || route.method === method),
  );
}
