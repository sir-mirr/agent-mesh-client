import { describe, expect, test } from "bun:test";
import { MESH_ERROR } from "@agent-mesh/contracts";
import { classifyAuditRpcError } from "../src/hub/audit-worker";

describe("audit retry classification", () => {
  test("dead-letters the Hub catch-all append failure", () => {
    expect(classifyAuditRpcError(-32000)).toBe("permanent");
  });

  test("keeps explicit Hub load shedding retryable", () => {
    expect(classifyAuditRpcError(MESH_ERROR.AUDIT_BUSY)).toBe("transient");
  });

  test("fails unknown transport-era RPC codes toward retry", () => {
    expect(classifyAuditRpcError(-32999)).toBe("transient");
  });
});
