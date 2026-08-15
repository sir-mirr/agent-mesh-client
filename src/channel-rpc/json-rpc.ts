export type JsonRpcId = string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorData {
  code: string;
  retryable: boolean;
  retry_after_ms?: number;
  detail?: string;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: JsonRpcErrorData;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export class ChannelRpcError extends Error {
  readonly rpcCode: number;
  readonly dataCode: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly closeConnection: boolean;

  constructor(options: {
    rpcCode: number;
    dataCode: string;
    message: string;
    retryable?: boolean;
    retryAfterMs?: number;
    closeConnection?: boolean;
  }) {
    super(options.message);
    this.name = "ChannelRpcError";
    this.rpcCode = options.rpcCode;
    this.dataCode = options.dataCode;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.closeConnection = options.closeConnection ?? false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonRpcRequest(value: unknown): JsonRpcRequest {
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.method !== "string" ||
    value.method.length === 0
  ) {
    throw new ChannelRpcError({
      rpcCode: -32600,
      dataCode: "INVALID_REQUEST",
      message: "Invalid JSON-RPC request",
      closeConnection: true,
    });
  }

  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: value.id,
    method: value.method,
  };
  if ("params" in value) {
    request.params = value.params;
  }
  return request;
}

export function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function failure(
  id: JsonRpcId | null,
  error: unknown,
): JsonRpcFailure {
  if (error instanceof ChannelRpcError) {
    const data: JsonRpcErrorData = {
      code: error.dataCode,
      retryable: error.retryable,
    };
    if (error.retryAfterMs !== undefined) {
      data.retry_after_ms = error.retryAfterMs;
    }
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: error.rpcCode,
        message: error.message,
        data,
      },
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32603,
      message: "Internal error",
      data: { code: "INTERNAL_ERROR", retryable: false },
    },
  };
}
