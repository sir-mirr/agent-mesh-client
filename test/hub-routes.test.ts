import { describe, expect, test } from "bun:test";
import { hubServes } from "../e2e/hub-routes";

describe("which server answers", () => {
  // The pair that made this a function. Routing by path alone sent the GET to
  // the hub, which answered 405, and I reported the route as one the contract
  // could not express. The contract was fine.
  test("one path, two servers, told apart by the method", () => {
    expect(hubServes("POST", "/api/v1/agents")).toBe(true);
    expect(hubServes("GET", "/api/v1/agents")).toBe(false);
  });

  // The branch I missed. `/api/v1/agents/{identity}/keys` is the hub's, and it
  // is GET -- the opposite method from the exact-match route one line above it
  // in the dispatcher. The contract suite caught this, not this test.
  test("the keys sub-path is the hub's, and only for GET", () => {
    expect(hubServes("GET", "/api/v1/agents/e2e-readback/keys")).toBe(true);
    expect(hubServes("POST", "/api/v1/agents/e2e-readback/keys")).toBe(false);
    // Not every sub-path of it: only the one ending in /keys.
    expect(hubServes("GET", "/api/v1/agents/e2e-readback")).toBe(false);
  });

  test("rpc is the hub's, and only for POST", () => {
    expect(hubServes("POST", "/api/v1/rpc")).toBe(true);
    expect(hubServes("GET", "/api/v1/rpc")).toBe(false);
  });

  // Prefixes the hub answers whatever the method is. Without these the test
  // above passes for a function that only ever says POST.
  test("and the method-agnostic prefixes stay the hub's for every method", () => {
    for (const method of ["GET", "POST", "DELETE"]) {
      expect(hubServes(method, "/api/v1/limits")).toBe(true);
      expect(hubServes(method, "/api/v1/mailbox/out")).toBe(true);
      expect(hubServes(method, "/api/v1/capabilities")).toBe(true);
    }
  });

  // The closed set: anything the hub does not claim is the http server's. A
  // default of "hub" would send every new admin route to a server that has
  // never heard of it, and the failure would read as a broken route.
  test("everything unclaimed belongs to the other server", () => {
    for (const path of [
      "/api/v1/admin/grants",
      "/api/v1/messages/search",
      "/api/v1/events/e2e-src",
      "/api/v1/ingest/ai-usage",
      "/api/v1/files",
    ]) {
      expect(hubServes("GET", path)).toBe(false);
      expect(hubServes("POST", path)).toBe(false);
    }
  });
});
