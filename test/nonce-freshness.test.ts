import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { SecretStore } from "../src/config/secrets";
import { IdentityKeyManager } from "../src/identity/key-manager";

/**
 * A retry must not reuse a nonce.
 *
 * The Hub consumes the nonce *before* it verifies the signature (§ 8.1), so a
 * request that failed on its signature has still spent its nonce. A client that
 * retries with the same one fails again for a different reason — replay, not
 * signature — and both answer the same error code, so the client cannot tell
 * them apart and retries forever.
 *
 * Nothing measured this on either side. The contract scenario being drafted
 * will ask whether the Hub enforces it; this asks whether this client obeys it,
 * which is the half no Hub-side test can see.
 */
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function manager(): Promise<IdentityKeyManager> {
  const root = await mkdtemp("/tmp/agent-mesh-nonce-");
  cleanups.push(() => rm(root, { recursive: true }));
  return new IdentityKeyManager("agent-a", new SecretStore(root));
}

describe("nonce freshness", () => {
  test("signing the same request twice produces different nonces and signatures", async () => {
    const keys = await manager();
    const method = "mesh.send";
    const params = new TextEncoder().encode(JSON.stringify({ to: "b", content: "hi" }));
    const first = await keys.signRequest(method, params);
    const second = await keys.signRequest(method, params);

    expect(first.nonce).not.toBe(second.nonce);
    // The signature covers the nonce, so an identical value would mean the
    // nonce is not in the preimage -- a fresh nonce nothing signs is not fresh.
    expect(first.value).not.toBe(second.value);
    expect(second.kid).toBe(first.kid);
  });

  /**
   * The outbox stores what to send, not a signed envelope. If it kept the
   * signature, every retry of a durable event would replay the nonce that was
   * minted when the event was first queued — which is exactly the case § 8.1
   * warns about, and the one a durable queue makes most likely.
   */
  test("the durable outbox stores no signature to replay", async () => {
    const source = await Bun.file("src/outbox/lane-outbox.ts").text();
    const schema = source.slice(source.indexOf("CREATE TABLE IF NOT EXISTS events"));
    const columns = schema.slice(0, schema.indexOf(");"));
    for (const forbidden of ["sig", "signature", "nonce", "authorization"]) {
      expect(columns.toLowerCase()).not.toContain(forbidden);
    }
    // And the send path signs where it sends, rather than reading one back.
    const client = await Bun.file("src/hub/mesh-client.ts").text();
    expect(client).toContain("await this.keyManager.signRequest(");
  });
});
