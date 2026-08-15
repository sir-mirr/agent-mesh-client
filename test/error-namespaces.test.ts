import { describe, expect, test } from "bun:test";
import { ERROR_CLASS, MESH_ERROR, RETIRED_ERROR_CODES } from "@agent-mesh/contracts";
import { CHANNEL_ERROR_CODES } from "../src/constants";

/**
 * Two protocols meet in this process and their error codes overlap.
 *
 * The Channel RPC is ours — a driver talking to the daemon over a local
 * socket. The Mesh RPC is the Hub's. Both allocate in the JSON-RPC
 * implementation-defined range and both started at -32040, so five numbers
 * mean one thing on one wire and something else on the other. -32043 is
 * `ATTACHMENT_INVALID` locally and `AUDIT_BUSY` to the Hub: a permanently
 * malformed attachment and an instruction to retry.
 *
 * Nothing crosses today, because classification takes a `HubRpcError` rather
 * than a number that could have come from anywhere. This pins the hazard so
 * that a new collision has to be looked at rather than merged in quietly, and
 * so that anyone tempted to classify a bare `code` finds out why not.
 */
describe("channel and mesh error namespaces", () => {
  const meshCodes = new Set<number>([...Object.values(MESH_ERROR), ...RETIRED_ERROR_CODES]);

  test("collides on exactly the five numbers already known to collide", () => {
    const collisions = Object.entries(CHANNEL_ERROR_CODES)
      .filter(([, code]) => meshCodes.has(code))
      .map(([name, code]) => `${code} ${name}`)
      .sort();
    expect(collisions).toEqual([
      "-32040 NOT_REGISTERED",
      "-32041 PROTOCOL_UNSUPPORTED",
      "-32042 CAPABILITY_UNSUPPORTED",
      "-32043 ATTACHMENT_INVALID",
      "-32044 DURABILITY_FAILED",
    ]);
  });

  test("would misread a channel code as a Hub retry policy", () => {
    // Not a bug report against ERROR_CLASS -- it is answering for the Hub's
    // wire, correctly. It is the reason a channel code must never reach it.
    expect(ERROR_CLASS[CHANNEL_ERROR_CODES.ATTACHMENT_INVALID]).toBe("transient");
    expect(ERROR_CLASS[CHANNEL_ERROR_CODES.DURABILITY_FAILED]).toBe("transient-operator");
  });
});
