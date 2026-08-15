import { Value } from "@sinclair/typebox/value";
import {
  ProvisionAgentRequest,
  ProvisionAgentResponse,
  type ProvisionAgentRequest as ProvisionRequest,
  type ProvisionAgentResponse as ProvisionResponse,
} from "@agent-mesh/contracts/schema";
import type { HubEndpoints } from "./endpoints";

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
    throw new Error(`Provisioning failed (${response.status}): ${JSON.stringify(body)}`);
  }
  // A 0.1 hub lacks the optional key response but otherwise returns this shape.
  if (!Value.Check(ProvisionAgentResponse, body)) {
    throw new Error(`Hub returned an invalid provisioning response: ${JSON.stringify(body)}`);
  }
  return body;
}
