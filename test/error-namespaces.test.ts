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

  /**
   * All three tests above filter an enumeration and expect nothing left. An
   * empty enumeration satisfies every one of them, and the suite would report
   * that the boundary is held while comparing no codes at all.
   *
   * The shape was measured next door the same night: a sweep reported zero
   * dropped fields across fourteen screens, and the number rose from 13 to 32
   * adjudications once data existed. Same code, same tool, nothing to look at.
   */
  test("there are codes on both sides to compare", () => {
    expect(Object.keys(CHANNEL_ERROR_CODES).length).toBeGreaterThan(0);
    expect(meshCodes.size).toBeGreaterThan(0);
    // And the two sets are the ones the tests above use, not empty stand-ins
    // that happen to satisfy a length check.
    expect(Object.values(CHANNEL_ERROR_CODES).every((code) => code < 0)).toBe(true);
  });

  // The matchers have to be able to say no, or the emptiness above is the only
  // reason the tests pass.
  test("and a code in the wrong half is detected", () => {
    const trespasser = { BORROWED: [...meshCodes][0]! };
    expect(Object.entries(trespasser).filter(([, code]) => meshCodes.has(code))).toHaveLength(1);
    expect(isMeshErrorCode(-32014)).toBe(true);
    expect(isMeshErrorCode(-32050)).toBe(false);
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
