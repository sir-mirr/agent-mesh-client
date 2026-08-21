import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { collectBundle, contractPin } from "../src/diagnostics/bundle";
import { diagnosticRing } from "../src/diagnostics/ring-buffer";
import { codeOnly } from "./support/code-only";

/**
 * A bundle is an attachment. Everything in it travels.
 *
 * The user runs one command and mails the result to someone they have never
 * met, so this is the one artifact in the client where "we did not think to
 * exclude that" ends with a private key in someone's inbox. The requirement
 * (`LOGGING-OPS.md` §1) is that the exclusion is held by a check rather than by
 * care, which is what this file is.
 *
 * Planted values, not shapes: a real private key, a real bot token and a real
 * message body are written into the sources a bundle reads, and the assertion
 * is that the serialised bundle does not contain those exact strings anywhere.
 * A test that asserted "the token field is masked" would pass while the same
 * token sat in an error message three sections down, which is how it would
 * actually leak.
 *
 * The contract-pin test is here rather than beside the collector because it is
 * the same class of fault: a value that is wrong while looking authoritative.
 * The installed package says `0.23.0` and the pinned tag is `v0.29.0`, six tags
 * apart, measured 2026-08-21 against the tree this landed in.
 */
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  diagnosticRing.clear();
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function workspace(): Promise<{ configFile: string; stateDirectory: string; runtimeDirectory: string }> {
  const root = await mkdtemp("/tmp/agent-mesh-bundle-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return {
    configFile: `${root}/config.yaml`,
    stateDirectory: `${root}/state`,
    // Nothing is listening here, which is the point: the daemon sections must
    // come back `unavailable` with a reason rather than empty.
    runtimeDirectory: `${root}/runtime`,
  };
}

describe("diagnostic bundle secrets", () => {
  test("a planted key, token and message body appear nowhere in the serialised bundle", async () => {
    const paths = await workspace();
    const privateKey = "PLANTEDNOTAREALPRIVATEKEY0000thisIsAPlantedPrivateKeyForTest";
    // Shaped like a bot token -- one long opaque run, which is what the masker
    // keys on -- but deliberately NOT in Discord's `<id>.<ts>.<hmac>` form. The
    // first version of this test used that form, and GitHub's push protection
    // read the planted value as a live credential and refused the push. A
    // planted secret has to be indistinguishable from a real one to the code
    // under test and distinguishable to everything else; the dotted form gave
    // up the second half for realism the masker never looks at.
    const botToken = "PLANTEDNOTAREALCREDENTIAL0123456789abcdefghijklmnopqrstuvwx";
    const messageBody = "the actual sentence a user typed into their channel";

    await writeFile(
      paths.configFile,
      `hub:\n  base_url: https://operator:${botToken}@hub.example\nlanes:\n  - id: lane-a\n    private_key_pkcs8: ${privateKey}\n`,
    );
    diagnosticRing.record({
      level: "error",
      component: "channel",
      // What a diagnostic is allowed to carry about a message: which one, how
      // big, which way, how it ended. The body rides along in `fields` here to
      // prove the masker takes it; the message text carries no prose, which is
      // the half held by the emission-site test below.
      message: "channel delivery failed for aud_0199aab1",
      fields: {
        token: botToken,
        body: messageBody,
        size: 412,
        direction: "outbound",
        private_key_pkcs8: privateKey,
      },
    });

    const serialised = JSON.stringify(await collectBundle(paths));

    expect(serialised).not.toContain(privateKey);
    expect(serialised).not.toContain(botToken);
    // The body is prose, so no shape rule catches it; it is excluded by the
    // field name and by nothing in the bundle carrying a body at all.
    expect(serialised).not.toContain(messageBody);
  });

  test("no diagnostic in the client interpolates a message body into its text", async () => {
    // The masker works by name and by shape. A body has neither: it is prose
    // under a key the caller chose, and the first version of this feature
    // masked `fields.body` while the same sentence sat in the free-text
    // `message` two keys away. This test measured that and is why the guard
    // moved to the emission sites.
    //
    // What it cannot see: a body reaching a diagnostic through a variable named
    // something else. It reads the call sites, not the values that flow into
    // them. The narrower claim it does hold is that no site names one.
    const sites = new Bun.Glob("src/**/*.ts");
    const offenders: string[] = [];
    for await (const path of sites.scan(".")) {
      if (path.startsWith("src/diagnostics/")) continue;
      const source = codeOnly(await Bun.file(path).text(), "slash");
      for (const call of source.matchAll(/#?onDiagnostic\(([\s\S]{0,200}?)\)/g)) {
        if (/\$\{[^}]*\b(body|content|text|payload|message_body)\b[^}]*\}/.test(call[1]!)) {
          offenders.push(`${path}: ${call[1]!.split("\n")[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the contract tag is read from the pin and not from the installed package", async () => {
    const pin = contractPin();
    expect(pin.outcome).toBe("read");
    expect(pin.value).toMatch(/^v\d+\.\d+\.\d+/);

    const installed = JSON.parse(
      await readFile("node_modules/@agent-mesh/contracts/package.json", "utf8"),
    ) as { version: string };
    // Not an accident to be tidied up: these disagree today, and the whole
    // reason the pin is the source is that the wrong one looks authoritative.
    // If a future tag makes them agree this assertion stops proving anything,
    // so it asserts the *source*, below, as well.
    expect(pin.value).toBe(`v${JSON.parse(await readFile("package.json", "utf8")).dependencies["@agent-mesh/contracts"].split("#v")[1]}`);
    expect(typeof installed.version).toBe("string");

    const source = codeOnly(await Bun.file("src/diagnostics/bundle.ts").text(), "slash");
    expect(source).toContain("manifest.dependencies?.[\"@agent-mesh/contracts\"]");
    expect(source).not.toMatch(/contracts\/package\.json/);
  });
});
