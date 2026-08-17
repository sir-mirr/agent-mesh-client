import { describe, expect, test } from "bun:test";
import { ERROR_CLASS, ERROR_DATA_CODE, MESH_ERROR, errorClass } from "@agent-mesh/contracts";
import { auditErrorCode, requestedDelay } from "../src/hub/audit-worker";
import { HubRpcError } from "../src/hub/mesh-client";

describe("audit retry classification", () => {
  test("dead-letters the Hub catch-all append failure", () => {
    expect(errorClass(MESH_ERROR.SERVER_ERROR, "transient")).toBe("permanent");
  });

  test("keeps explicit Hub load shedding retryable", () => {
    expect(errorClass(MESH_ERROR.AUDIT_BUSY, "transient")).toBe("transient");
  });

  // v0.7.4 made the answer for an unlisted code an argument, because no single
  // answer is right on every path. The audit worker passes "transient" and
  // this asserts the choice, not the contract's opinion: a wrong retry here is
  // capped by the backoff ceiling and drains later, while a wrong dead-letter
  // waits for `outbox replay` and someone to run it.
  test("retries codes this pin has never heard of, because a queue holds them", () => {
    expect(errorClass(-32999, "transient")).toBe("transient");
  });

  // The same call on a path with no outbox behind it. Kept next to the case
  // above so the pair reads as a decision rather than an accident.
  test("quarantines an unknown code where nothing would drain it later", () => {
    expect(errorClass(-32999, "permanent")).toBe("permanent");
  });

  // Under the v0.7.0 pin, -32000 was classified only because this repository
  // hardcoded it: the contracts table had no entry and a local fallback
  // absorbed the gap silently. Asserting one code at a time cannot catch the
  // code nobody thought to assert, so require the whole § 8.9.3 set to be
  // present in the table rather than merely to survive the default.
  test("classifies every audit failure code from the table, not the default", () => {
    const auditCodes = [
      MESH_ERROR.AUDIT_MISSING_BLOBS,
      MESH_ERROR.AUDIT_EVENT_CONFLICT,
      MESH_ERROR.AUDIT_BUSY,
      MESH_ERROR.AUDIT_STORAGE_EXHAUSTED,
      MESH_ERROR.SERVER_ERROR,
    ];
    const classified = auditCodes.map((code) => ({
      code,
      inTable: Object.hasOwn(ERROR_CLASS, code),
      class: errorClass(code, "transient"),
    }));
    expect(classified).toEqual([
      { code: MESH_ERROR.AUDIT_MISSING_BLOBS, inTable: true, class: "transient" },
      { code: MESH_ERROR.AUDIT_EVENT_CONFLICT, inTable: true, class: "permanent" },
      { code: MESH_ERROR.AUDIT_BUSY, inTable: true, class: "transient" },
      {
        code: MESH_ERROR.AUDIT_STORAGE_EXHAUSTED,
        inTable: true,
        class: "transient-operator",
      },
      { code: MESH_ERROR.SERVER_ERROR, inTable: true, class: "permanent" },
    ]);
  });
});

describe("audit error code recording", () => {
  test("records the data.code discriminator when the Hub sends one", () => {
    const error = new HubRpcError(MESH_ERROR.SERVER_ERROR, "append failed", {
      code: ERROR_DATA_CODE.AUDIT_APPEND_FAILED,
    });
    expect(auditErrorCode(error)).toBe("AUDIT_APPEND_FAILED");
  });

  test("falls back to the numeric code when no vocabulary is carried", () => {
    // The dispatcher's last-resort guard shares -32000 with the audit failure
    // and carries no data. Recording "AUDIT_APPEND_FAILED" for it would name a
    // condition that did not happen.
    const error = new HubRpcError(MESH_ERROR.SERVER_ERROR, "internal error");
    expect(auditErrorCode(error)).toBe("-32000");
  });

  test("rejects a data.code inherited from the prototype chain", () => {
    const error = new HubRpcError(MESH_ERROR.SERVER_ERROR, "internal error", {
      code: "toString",
    });
    expect(auditErrorCode(error)).toBe("-32000");
  });
});

describe("server-requested retry delays", () => {
  // The Hub knows when it will be ready and this client does not. Ignoring the
  // number it sends means retrying early against a Hub that is shedding load,
  // which is the behaviour the limit exists to stop.
  test("prefers the Hub's delay over the local backoff", () => {
    expect(requestedDelay({ retry_after_ms: 4_500 })).toBe(4_500);
    expect(requestedDelay({ retry_after: 3 })).toBe(3_000);
  });

  // Zero would mean "immediately", which is the loop being rate-limited. Read
  // as absent so the local backoff decides instead.
  test("ignores a zero or missing delay rather than retrying at once", () => {
    expect(requestedDelay({ retry_after_ms: 0 })).toBeNull();
    expect(requestedDelay({ retry_after: 0 })).toBeNull();
    expect(requestedDelay({})).toBeNull();
    expect(requestedDelay(null)).toBeNull();
  });
});
