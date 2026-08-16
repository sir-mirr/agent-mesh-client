import { describe, expect, test } from "bun:test";
import {
  MESH_ERROR,
  MESH_ERROR_RANGE,
  RETIRED_ERROR_CODES,
  isMeshErrorCode,
} from "@agent-mesh/contracts";
import { CHANNEL_ERROR_CODES } from "../src/constants";

/**
 * Two protocols meet in this process. The Channel RPC is ours — a driver
 * talking to the daemon over a local socket. The Mesh RPC is the Hub's. Both
 * allocate from the JSON-RPC implementation-defined range, and both used to
 * start at -32040, so five numbers meant one thing on one wire and something
 * else on the other. -32043 was `ATTACHMENT_INVALID` here and `AUDIT_BUSY`
 * there: a permanently malformed attachment and an instruction to retry.
 *
 * contracts v0.7.5 split the range — the mesh takes -32049…-32000 and promises
 * never to assign above it — so the channel codes moved into -32099…-32050.
 * These tests hold that line from this side; the contract cannot see our codes.
 */
describe("channel and mesh error namespaces", () => {
  const meshCodes = new Set<number>([...Object.values(MESH_ERROR), ...RETIRED_ERROR_CODES]);

  test("allocates every channel code outside the mesh's half", () => {
    const inMeshHalf = Object.entries(CHANNEL_ERROR_CODES)
      .filter(([, code]) => isMeshErrorCode(code))
      .map(([name, code]) => `${code} ${name}`);
    expect(inMeshHalf).toEqual([]);
  });

  test("shares no number with a live or retired mesh code", () => {
    const collisions = Object.entries(CHANNEL_ERROR_CODES)
      .filter(([, code]) => meshCodes.has(code))
      .map(([name, code]) => `${code} ${name}`);
    expect(collisions).toEqual([]);
  });

  // Reserved for us is not the same as ours by accident. A code below -32099
  // leaves the implementation-defined range altogether and collides with
  // JSON-RPC's own predefined errors.
  test("keeps every channel code inside the range left to layered protocols", () => {
    const outside = Object.entries(CHANNEL_ERROR_CODES)
      .filter(([, code]) => code > MESH_ERROR_RANGE.min - 1 || code < -32099)
      .map(([name, code]) => `${code} ${name}`);
    expect(outside).toEqual([]);
  });
});
