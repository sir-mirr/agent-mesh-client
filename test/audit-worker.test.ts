import { describe, expect, test } from "bun:test";
import { ERROR_CLASS, ERROR_DATA_CODE, MESH_ERROR, errorClass } from "@agent-mesh/contracts";
import { auditErrorCode } from "../src/hub/audit-worker";
import { HubRpcError } from "../src/hub/mesh-client";

describe("audit retry classification", () => {
  test("dead-letters the Hub catch-all append failure", () => {
    expect(errorClass(MESH_ERROR.SERVER_ERROR)).toBe("permanent");
  });

  test("keeps explicit Hub load shedding retryable", () => {
    expect(errorClass(MESH_ERROR.AUDIT_BUSY)).toBe("transient");
  });

  // Reversed at contracts v0.7.3, and the reversal is the point: an unlisted
  // code comes from a Hub newer than this pin, and retrying it forever is the
  // failure -32000 already caused once. Permanent means quarantine and alert,
  // so an unknown condition reaches a person instead of a retry loop.
  test("fails codes this pin has never heard of toward quarantine", () => {
    expect(errorClass(-32999)).toBe("permanent");
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
      class: errorClass(code),
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
