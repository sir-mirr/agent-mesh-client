export interface HubEndpoints {
  baseUrl: string;
  rpcWebSocket: string;
  apiHttp: string;
}

export function resolveHubEndpoints(
  baseUrl: string,
  overrides: { rpc_ws?: string; api_http?: string } = {},
): HubEndpoints {
  const url = new URL(baseUrl);
  const isWebSocket = url.protocol === "ws:" || url.protocol === "wss:";
  if (!isWebSocket && url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Hub URL must use http(s) or ws(s)");
  }
  const http = new URL(url);
  http.protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
  if (http.pathname.endsWith("/ws")) http.pathname = http.pathname.slice(0, -3) || "/";
  const websocket = new URL(url);
  websocket.protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  if (!websocket.pathname.endsWith("/ws")) {
    websocket.pathname = `${websocket.pathname.replace(/\/$/, "")}/ws`;
  }
  return {
    baseUrl: http.toString().replace(/\/$/, ""),
    rpcWebSocket: overrides.rpc_ws ?? websocket.toString(),
    apiHttp: overrides.api_http ?? http.toString().replace(/\/$/, ""),
  };
}

export async function probeHub(baseUrl: string): Promise<{
  ok: boolean;
  endpoints: HubEndpoints;
  health: unknown;
}> {
  const endpoints = resolveHubEndpoints(baseUrl);
  const response = await fetch(`${endpoints.apiHttp}/health`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Hub health returned HTTP ${response.status}`);
  return { ok: true, endpoints, health: await response.json() };
}
