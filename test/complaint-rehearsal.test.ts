import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { collectBundle, type DiagnosticBundle } from "../src/diagnostics/bundle";
import { diagnosticRing } from "../src/diagnostics/ring-buffer";

/**
 * Three fake complaints, answered from the bundle alone.
 *
 * This is the acceptance criterion for the whole feature (`LOGGING-OPS.md` §3),
 * turned into a test rather than left as a rehearsal someone runs by hand: a
 * cause is planted, a bundle is collected, and a reader that sees only the
 * bundle must name the failing layer. If the reader cannot, the gap is the
 * remaining work — that is the shape of the criterion, and a test is the only
 * way to keep it from drifting once the code moves.
 *
 * The reader here is `explain()`, deliberately mechanical. It walks the ring
 * for the correlation id and reports which layers were observed, in the shape
 * PM fixed: **[correlation id] · per-layer O/X · → failing layer.** A reader
 * with judgement would pass this test on evidence a human would not accept.
 *
 * What this cannot show: whether the server half agrees. Pairing is by time,
 * endpoint and actor until T-022 (`LOGGING-OPS.md` §5), and this test has no
 * server. It asserts the client half is sufficient to name a layer, which is
 * the half that lives in this repository.
 */
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  diagnosticRing.clear();
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function bundleOf(): Promise<DiagnosticBundle> {
  const base = await mkdtemp("/tmp/agent-mesh-rehearsal-");
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  return collectBundle({
    configFile: `${base}/config.yaml`,
    stateDirectory: `${base}/state`,
    runtimeDirectory: `${base}/runtime`,
  });
}

/** Layers a complaint can die in, in the order a request crosses them. */
const LAYERS = ["client-send", "transport", "credential", "push-subscription"] as const;

/**
 * Read the bundle the way an operator would: follow one id, see which layers
 * left a mark, name the first one that recorded a failure.
 */
function explain(bundle: DiagnosticBundle, correlationId: string): string {
  const records = (bundle.ring.value?.records ?? []).filter(
    (record) => record.correlationId === correlationId,
  );
  const observed = LAYERS.map((layer) => {
    const seen = records.filter((record) => record.component === layer);
    if (seen.length === 0) return `${layer} X`;
    return `${layer} ${seen.some((record) => record.level === "error") ? "FAIL" : "O"}`;
  });
  const failing = records.find((record) => record.level === "error");
  return `${correlationId} · ${observed.join(" · ")} · → ${failing ? failing.component : "unknown"}`;
}

describe("complaint rehearsal", () => {
  test("A: a message that never arrived is placed in the transport layer", async () => {
    const id = "aud_0199aab1-84f2-7000-8000-000000000001";
    diagnosticRing.record({
      level: "info",
      component: "client-send",
      message: "outbound event queued",
      correlationId: id,
      fields: { size: 412, direction: "outbound" },
    });
    diagnosticRing.record({
      level: "error",
      component: "transport",
      message: "hub connect failed",
      correlationId: id,
      fields: { endpoint: "/api/v1/rpc", attempts: 3, code: "ECONNREFUSED" },
    });

    const sentence = explain(await bundleOf(), id);
    expect(sentence).toContain("client-send O");
    expect(sentence).toContain("transport FAIL");
    expect(sentence).toEndWith("→ transport");
    // Not the credential layer, which is the wrong-turn this complaint invites:
    // "it stopped working" reads as "my login broke" to most users.
    expect(sentence).toContain("credential X");
  });

  test("B: repeated 401s are placed in the credential layer and not in transport", async () => {
    const id = "op_0199aab1-84f2-7000-8000-000000000002";
    diagnosticRing.record({
      level: "info",
      component: "transport",
      message: "hub reachable",
      correlationId: id,
      fields: { endpoint: "/api/v1/agents", status: 200 },
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      diagnosticRing.record({
        level: "error",
        component: "credential",
        message: "login refused",
        correlationId: id,
        fields: { endpoint: "/api/v1/agents", status: 401, code: "AUTH_BAD_CREDENTIALS", attempt },
      });
    }

    const sentence = explain(await bundleOf(), id);
    // The whole value of the sentence is this pair: the network was fine and
    // the credential was not, which is the opposite of what a user reports.
    expect(sentence).toContain("transport O");
    expect(sentence).toContain("credential FAIL");
    expect(sentence).toEndWith("→ credential");

    const errors = (await bundleOf()).recent_errors.value as Array<{ fields: Record<string, unknown> }>;
    expect(errors.filter((record) => record.fields.status === 401)).toHaveLength(3);
    expect(errors[0]!.fields.code).toBe("AUTH_BAD_CREDENTIALS");
  });

  test("C: a delivered message with no notification is placed in the push subscription layer", async () => {
    const id = "aud_0199aab1-84f2-7000-8000-000000000003";
    diagnosticRing.record({
      level: "info",
      component: "client-send",
      message: "outbound event queued",
      correlationId: id,
      fields: { size: 88, direction: "outbound" },
    });
    diagnosticRing.record({
      level: "info",
      component: "transport",
      message: "hub acknowledged event",
      correlationId: id,
      fields: { endpoint: "/api/v1/rpc", status: 200 },
    });
    diagnosticRing.record({
      level: "error",
      component: "push-subscription",
      message: "push endpoint rejected the notification",
      correlationId: id,
      fields: { status: 404, code: "SUBSCRIPTION_EXPIRED" },
    });

    const sentence = explain(await bundleOf(), id);
    // Sent and acknowledged, so neither of the layers the user suspects is at
    // fault; the fault is downstream of the part that "worked".
    expect(sentence).toContain("client-send O");
    expect(sentence).toContain("transport O");
    expect(sentence).toEndWith("→ push-subscription");
  });

  test("a layer that recorded nothing reads as X and never as O", async () => {
    const id = "aud_0199aab1-84f2-7000-8000-000000000004";
    diagnosticRing.record({
      level: "info",
      component: "client-send",
      message: "outbound event queued",
      correlationId: id,
      fields: { direction: "outbound" },
    });

    const sentence = explain(await bundleOf(), id);
    // The rehearsal's own version of ③. A silent layer is unobserved, and an
    // unobserved layer that printed `O` would let a reader conclude "the
    // transport was fine" from a bundle in which the transport never spoke.
    expect(sentence).toContain("transport X");
    expect(sentence).toContain("push-subscription X");
    expect(sentence).toEndWith("→ unknown");
  });
});
