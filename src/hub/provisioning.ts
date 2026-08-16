import { Value } from "@sinclair/typebox/value";
import {
  ProvisionAgentRequest,
  ProvisionAgentResponse,
  type ProvisionAgentRequest as ProvisionRequest,
  type ProvisionAgentResponse as ProvisionResponse,
} from "@agent-mesh/contracts/schema";
import type { HubEndpoints } from "./endpoints";
import { IDENTITY_RE } from "@agent-mesh/contracts";

export interface RegisteredAgentIdentity {
  identity: string;
  /**
   * The type the Hub has registered, when it reports one.
   *
   * Absent on Hubs that predate the field, so callers still need a fallback.
   */
  type?: string;
  deleted: boolean;
  keyStatus: string | null;
  keys: Array<{ fingerprint: string; status: string }>;
}

export class AgentIdentityConflictError extends Error {
  constructor(
    readonly identity: string,
    readonly code: "IDENTITY_EXISTS" | "IDENTITY_DELETED",
    message: string,
  ) {
    super(message);
    this.name = "AgentIdentityConflictError";
  }
}

export async function lookupAgentIdentity(
  endpoints: HubEndpoints,
  identity: string,
): Promise<RegisteredAgentIdentity | null> {
  if (!IDENTITY_RE.test(identity)) throw new Error(`Invalid Agent Identity: ${identity}`);
  const response = await fetch(
    `${endpoints.apiHttp}/api/v1/agents/${encodeURIComponent(identity)}/keys`,
    { signal: AbortSignal.timeout(10_000) },
  );
  const raw = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(`Hub identity lookup returned non-JSON HTTP ${response.status}`);
  }
  if (response.status === 404) {
    if (
      typeof body === "object" && body !== null &&
      "ok" in body && body.ok === false &&
      "error" in body && typeof body.error === "string" &&
      body.error.includes("is not registered")
    ) {
      return null;
    }
    throw new Error(`Hub identity lookup returned an ambiguous 404: ${raw}`);
  }
  if (!response.ok) {
    throw new Error(`Hub identity lookup failed (${response.status}): ${raw}`);
  }
  if (
    typeof body !== "object" || body === null ||
    !("ok" in body) || body.ok !== true ||
    !("identity" in body) || body.identity !== identity ||
    !("deleted" in body) || typeof body.deleted !== "boolean" ||
    !("keys" in body) || !Array.isArray(body.keys) ||
    !body.keys.every(
      (key) => typeof key === "object" && key !== null &&
        "fingerprint" in key && typeof key.fingerprint === "string" &&
        "status" in key && typeof key.status === "string",
    )
  ) {
    throw new Error(`Hub returned an invalid identity lookup response: ${raw}`);
  }
  return {
    identity,
    ...("type" in body && typeof body.type === "string" ? { type: body.type } : {}),
    deleted: body.deleted,
    keyStatus:
      "key_status" in body && typeof body.key_status === "string"
        ? body.key_status
        : null,
    keys: body.keys.map((key) => ({
      fingerprint: key.fingerprint as string,
      status: key.status as string,
    })),
  };
}

export async function provisionAgent(
  endpoints: HubEndpoints,
  request: ProvisionRequest,
): Promise<ProvisionResponse> {
  if (!Value.Check(ProvisionAgentRequest, request)) {
    const errors = [...Value.Errors(ProvisionAgentRequest, request)]
      .map((error) => `${error.path || "/"}: ${error.message}`)
      .join(", ");
    throw new Error(`Invalid provisioning request: ${errors}`);
  }
  const response = await fetch(`${endpoints.apiHttp}/api/v1/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    if (
      response.status === 409 && typeof body === "object" && body !== null &&
      "identity" in body && body.identity === request.identity &&
      "code" in body && (body.code === "IDENTITY_EXISTS" || body.code === "IDENTITY_DELETED") &&
      "error" in body && typeof body.error === "string"
    ) {
      throw new AgentIdentityConflictError(request.identity, body.code, body.error);
    }
    throw new Error(`Provisioning failed (${response.status}): ${JSON.stringify(body)}`);
  }
  // A 0.1 hub lacks the optional key response but otherwise returns this shape.
  if (!Value.Check(ProvisionAgentResponse, body)) {
    throw new Error(`Hub returned an invalid provisioning response: ${JSON.stringify(body)}`);
  }
  return body;
}
