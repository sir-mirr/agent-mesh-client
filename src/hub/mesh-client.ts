import {
  MESH_ERROR,
  type AuditCapabilities,
} from "@agent-mesh/contracts";
import type { MeshMessageParams } from "@agent-mesh/contracts/schema";
import type { IdentityKeyManager } from "../identity/key-manager";
import { prefixedId } from "../util/ids";
import type { HubEndpoints } from "./endpoints";

interface RpcFailure {
  code: number;
  message: string;
  data?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HubRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "HubRpcError";
  }
}

export interface MeshConnectionStatus {
  state: "disconnected" | "connecting" | "connected" | "approval" | "failed";
  identity: string;
  lastError: string | null;
  connectedAt: string | null;
  audit: AuditCapabilities | null;
}

export class MeshClient {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #messageHandlers = new Set<(message: MeshMessageParams) => void | Promise<void>>();
  #socket: WebSocket | null = null;
  #status: MeshConnectionStatus;

  constructor(
    readonly endpoints: HubEndpoints,
    readonly identity: string,
    readonly keyManager: IdentityKeyManager,
  ) {
    this.#status = {
      state: "disconnected",
      identity,
      lastError: null,
      connectedAt: null,
      audit: null,
    };
  }

  get status(): MeshConnectionStatus {
    return { ...this.#status };
  }

  onMessage(handler: (message: MeshMessageParams) => void | Promise<void>): () => void {
    this.#messageHandlers.add(handler);
    return () => this.#messageHandlers.delete(handler);
  }

  async connect(): Promise<void> {
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    this.#status = { ...this.#status, state: "connecting", lastError: null };
    const socket = new WebSocket(this.endpoints.rpcWebSocket);
    this.#socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Hub WebSocket open timed out")), 15_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Hub WebSocket failed to open"));
      }, { once: true });
    });
    socket.addEventListener("message", (event) => this.#handleMessage(String(event.data)));
    socket.addEventListener("close", () => this.#handleClose());
    socket.addEventListener("error", () => {
      this.#status = { ...this.#status, lastError: "Hub WebSocket error" };
    });

    try {
      const result = (await this.call("mesh.connect", {
        identity: this.identity,
      })) as { capabilities?: { audit?: AuditCapabilities } };
      this.#status = {
        state: "connected",
        identity: this.identity,
        lastError: null,
        connectedAt: new Date().toISOString(),
        audit: result.capabilities?.audit ?? null,
      };
    } catch (error) {
      if (error instanceof HubRpcError && error.code === MESH_ERROR.KEY_NOT_APPROVED) {
        this.#status = {
          ...this.#status,
          state: "approval",
          lastError: error.message,
        };
      } else {
        this.#status = {
          ...this.#status,
          state: "failed",
          lastError: error instanceof Error ? error.message : String(error),
        };
      }
      socket.close();
      throw error;
    }
  }

  async call(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Hub WebSocket is not connected");
    }
    const id = prefixedId("rpc");
    const rawParams = Buffer.from(JSON.stringify(params), "utf8");
    const signature = await this.keyManager.signRequest(method, rawParams);
    const wire = `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":${JSON.stringify(method)},"params":${rawParams.toString("utf8")},"sig":${JSON.stringify(signature)}}`;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Hub request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    socket.send(wire);
    return await response;
  }

  async send(
    to: string,
    content: string,
    replyTo?: string | null,
    clientMessageId = prefixedId("send"),
  ): Promise<unknown> {
    return await this.call("mesh.send", {
      to,
      content,
      ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
      client_message_id: clientMessageId,
    });
  }

  async listAgents(): Promise<unknown> {
    return await this.call("mesh.list_agents", {});
  }

  async fetchMessages(params: Record<string, unknown> = {}): Promise<unknown> {
    return await this.call("mesh.fetch_messages", params);
  }

  close(): void {
    this.#socket?.close();
    this.#socket = null;
    this.#rejectPending("Hub connection closed");
    this.#status = { ...this.#status, state: "disconnected", connectedAt: null };
  }

  #handleMessage(text: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id === "string") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error && typeof message.error === "object") {
        const failure = message.error as RpcFailure;
        pending.reject(new HubRpcError(failure.code, failure.message, failure.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method === "mesh.message" && message.params) {
      const params = message.params as MeshMessageParams;
      for (const handler of this.#messageHandlers) {
        void Promise.resolve(handler(params)).catch(() => undefined);
      }
    }
  }

  #handleClose(): void {
    this.#socket = null;
    this.#rejectPending("Hub connection closed");
    if (this.#status.state !== "approval") {
      this.#status = { ...this.#status, state: "disconnected", connectedAt: null };
    }
  }

  #rejectPending(message: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.#pending.clear();
  }
}
