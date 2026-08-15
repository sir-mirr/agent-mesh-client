import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { SecretStore } from "../src/config/secrets";
import { IdentityKeyManager } from "../src/identity/key-manager";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function store(): Promise<SecretStore> {
  const root = await mkdtemp("/tmp/agent-mesh-identity-");
  cleanups.push(() => rm(root, { recursive: true }));
  return new SecretStore(root);
}

async function fileCount(secrets: SecretStore): Promise<number> {
  return (await readdir(secrets.directory).catch(() => [])).length;
}

describe("IdentityKeyManager", () => {
  /**
   * `lane add` asks "do we already hold this identity's key?" to tell an agent
   * being reclaimed from a name somebody else registered. Answering with
   * `ensure` would create the key while looking for it, and then every
   * comparison is against a key that did not exist a moment ago -- the check
   * manufactures its own answer, consistently, which is why nothing downstream
   * would look wrong.
   */
  test("reading a missing key neither invents one nor writes anything", async () => {
    const secrets = await store();
    const manager = new IdentityKeyManager("agent-a", secrets);

    expect(await manager.peek()).toBeNull();
    expect(await fileCount(secrets)).toBe(0);
    // Twice: a first call that created the file would make the second lie.
    expect(await manager.peek()).toBeNull();
  });

  test("reads back exactly the key that was created", async () => {
    const secrets = await store();
    const manager = new IdentityKeyManager("agent-a", secrets);
    const created = await manager.ensure();

    const seen = await manager.peek();
    expect(seen?.fingerprint).toBe(created.fingerprint);
    expect(seen?.publicKey).toBe(created.publicKey);
    expect(seen?.fingerprint).toMatch(/^sha256:/);
  });

  test("survives the process that created it", async () => {
    const secrets = await store();
    const created = await new IdentityKeyManager("agent-a", secrets).ensure();

    // A fresh manager holds no cached record, which is the state a restarted
    // daemon -- or a `lane add` after `lane remove` -- actually starts from.
    const reopened = await new IdentityKeyManager("agent-a", secrets).peek();
    expect(reopened?.fingerprint).toBe(created.fingerprint);
  });

  test("keeps one identity's key out of another's answer", async () => {
    const secrets = await store();
    await new IdentityKeyManager("agent-a", secrets).ensure();

    expect(await new IdentityKeyManager("agent-b", secrets).peek()).toBeNull();
  });
});
