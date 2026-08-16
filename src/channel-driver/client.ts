import { createConnection, type Socket } from "node:net";
import { laneSocketPath } from "../config/paths";
import { CHANNEL_ERROR_CODES } from "../constants";
import { encodeFrame, NdjsonDecoder } from "../channel-rpc/ndjson";
import { prefixedId } from "../util/ids";

export interface ChannelDriverIdentity {
  laneId: string;
  driverInstanceId: string;
  provider: string;
  accountRef: string;
  stagingRoot: string;
  capabilities: string[];
}

export type DriverRequestHandler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

export class ChannelDriverClient {
  readonly #pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  #socket: Socket | null = null;
  #handler: DriverRequestHandler | null = null;

  constructor(
    readonly runtimeDirectory: string,
    readonly identity: ChannelDriverIdentity,
  ) {}

  onRequest(handler: DriverRequestHandler): void {
    this.#handler = handler;
  }

  async connect(): Promise<void> {
    if (this.#socket && !this.#socket.destroyed) return;
    const socket = createConnection(
      laneSocketPath(this.runtimeDirectory, this.identity.laneId),
    );
    this.#socket = socket;
    const decoder = new NdjsonDecoder();
    socket.on("data", (chunk) => {
      let frames: unknown[];
      try {
        frames = decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      } catch (error) {
        socket.destroy(error as Error);
        return;
      }
      for (const frame of frames) void this.#handle(frame);
    });
    socket.once("close", () => this.#disconnect(new Error("Lane socket closed")));
    socket.once("error", (error) => this.#disconnect(error));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    await this.call("channel.register", {
      protocol_version: "0.1",
      lane_id: this.identity.laneId,
      driver_instance_id: this.identity.driverInstanceId,
      provider: this.identity.provider,
      account_ref: this.identity.accountRef,
      staging_root: this.identity.stagingRoot,
      capabilities: this.identity.capabilities,
    });
  }

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.#socket;
    if (!socket || socket.destroyed) throw new Error("Lane socket is not connected");
    const id = prefixedId("drv");
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Lane RPC timed out: ${method}`));
      }, 30_000);
      this.#pending.set(id, { resolve, reject, timer });
    });
    socket.write(
      encodeFrame({ jsonrpc: "2.0", id, method, params }),
      (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (pending) clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending?.reject(error);
      },
    );
    return await result;
  }

  close(): void {
    this.#socket?.end();
    this.#socket = null;
    this.#disconnect(new Error("Channel driver closed"));
  }

  async #handle(value: unknown): Promise<void> {
    if (!value || typeof value !== "object") return;
    const frame = value as Record<string, unknown>;
    if (typeof frame.id !== "string") return;
    if (typeof frame.method !== "string") {
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      this.#pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error && typeof frame.error === "object") {
        const error = frame.error as { message?: unknown };
        pending.reject(
          new Error(
            typeof error.message === "string" ? error.message : "Lane RPC failed",
          ),
        );
      } else pending.resolve(frame.result);
      return;
    }
    try {
      if (!this.#handler) throw new Error(`Unsupported method: ${frame.method}`);
      const params =
        frame.params && typeof frame.params === "object" && !Array.isArray(frame.params)
          ? (frame.params as Record<string, unknown>)
          : {};
      const result = await this.#handler(frame.method, params);
      this.#socket?.write(encodeFrame({ jsonrpc: "2.0", id: frame.id, result }));
    } catch (error) {
      this.#socket?.write(
        encodeFrame({
          jsonrpc: "2.0",
          id: frame.id,
          error: {
            code: CHANNEL_ERROR_CODES.PROVIDER_FAILED,
            message: error instanceof Error ? error.message : String(error),
            data: { code: "CHANNEL_PROVIDER_FAILED", retryable: true },
          },
        }),
      );
    }
  }

  #disconnect(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    if (this.#socket?.destroyed) this.#socket = null;
  }
}
