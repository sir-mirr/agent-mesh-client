import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import {
  LaneServer,
  type ChannelRequestHandler,
} from "../src/channel-rpc/lane-server";
import { encodeFrame, NdjsonDecoder } from "../src/channel-rpc/ndjson";
import type { JsonRpcResponse } from "../src/channel-rpc/json-rpc";
import { HostDaemon, probeHostDaemon } from "../src/daemon/host-daemon";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

class RpcClient {
  readonly socket: Socket;
  readonly #decoder = new NdjsonDecoder();
  readonly #values: unknown[] = [];
  readonly #waiters: Array<(value: unknown) => void> = [];

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk) => {
      for (const value of this.#decoder.push(Buffer.from(chunk))) {
        const waiter = this.#waiters.shift();
        if (waiter) waiter(value);
        else this.#values.push(value);
      }
    });
  }

  static async connect(path: string): Promise<RpcClient> {
    const socket = createConnection(path);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new RpcClient(socket);
  }

  async request(value: unknown): Promise<JsonRpcResponse> {
    const response = this.receive();
    this.socket.write(encodeFrame(value));
    return (await response) as JsonRpcResponse;
  }

  async receive(): Promise<unknown> {
    return await new Promise<unknown>((resolve) => {
      const queued = this.#values.shift();
      if (queued !== undefined) resolve(queued);
      else this.#waiters.push(resolve);
    });
  }

  send(value: unknown): void {
    this.socket.write(encodeFrame(value));
  }
}

async function testDirectory(): Promise<string> {
  // Darwin's canonical temporary directory is already long enough to exceed
  // the Unix socket path limit once a hashed lane filename is appended.
  const path = await mkdtemp(join("/tmp", "agent-mesh-lane-"));
  cleanups.push(() => rm(path, { recursive: true }));
  return path;
}

function registration(id = "register-1") {
  return {
    jsonrpc: "2.0",
    id,
    method: "channel.register",
    params: {
      protocol_version: "0.1",
      lane_id: "lane-a",
      driver_instance_id: "discord-main-1",
      provider: "discord",
      account_ref: "account-opaque",
      staging_root: "/tmp/agent-mesh-staging",
      capabilities: ["message.receive", "message.send", "typing.send"],
    },
  };
}

describe("LaneServer", () => {
  test("requires registration as the first request and closes", async () => {
    const runtimeDirectory = await testDirectory();
    const lane = new LaneServer({ laneId: "lane-a", runtimeDirectory });
    await lane.start();
    cleanups.push(() => lane.stop());
    const client = await RpcClient.connect(lane.socketPath);

    const response = await client.request({
      jsonrpc: "2.0",
      id: "drv-1",
      method: "channel.message.received",
      params: {},
    });
    expect("error" in response && response.error.code).toBe(-32040);
    expect("error" in response && response.error.data?.code).toBe(
      "CHANNEL_NOT_REGISTERED",
    );
  });

  test("negotiates capabilities and applies socket mode 0600", async () => {
    const runtimeDirectory = await testDirectory();
    const lane = new LaneServer({ laneId: "lane-a", runtimeDirectory });
    await lane.start();
    cleanups.push(() => lane.stop());
    const client = await RpcClient.connect(lane.socketPath);

    const response = await client.request(registration());
    expect("result" in response && response.result).toMatchObject({
      protocol_version: "0.1",
      max_frame_bytes: 10 * 1024 * 1024,
      max_attachment_bytes: 100 * 1024 * 1024,
      capabilities: ["message.receive", "message.send"],
    });
    expect((await stat(lane.socketPath)).mode & 0o777).toBe(0o600);
    expect(lane.activeDriverCount).toBe(1);
  });

  test("uses the registered socket for outbound provider requests", async () => {
    const runtimeDirectory = await testDirectory();
    const lane = new LaneServer({ laneId: "lane-a", runtimeDirectory });
    await lane.start();
    cleanups.push(() => lane.stop());
    const client = await RpcClient.connect(lane.socketPath);
    await client.request(registration());

    const pending = lane.requestDriver("discord-main-1", "channel.message.send", {
      driver_instance_id: "discord-main-1",
      action_id: "act-test",
      text: "hello",
    });
    const request = (await client.receive()) as {
      id: string;
      method: string;
      params: Record<string, unknown>;
    };
    expect(request.method).toBe("channel.message.send");
    expect(request.params.action_id).toBe("act-test");
    client.send({
      jsonrpc: "2.0",
      id: request.id,
      result: { provider_message_id: "discord-message-1" },
    });
    expect(await pending).toEqual({ provider_message_id: "discord-message-1" });
  });

  test("fails inbound closed until durable storage is available", async () => {
    const runtimeDirectory = await testDirectory();
    const lane = new LaneServer({ laneId: "lane-a", runtimeDirectory });
    await lane.start();
    cleanups.push(() => lane.stop());
    const client = await RpcClient.connect(lane.socketPath);
    await client.request(registration());

    const response = await client.request({
      jsonrpc: "2.0",
      id: "message-1",
      method: "channel.message.received",
      params: { driver_instance_id: "discord-main-1", attachments: [] },
    });
    expect("error" in response && response.error.code).toBe(-32044);
    expect("error" in response && response.error.data?.retryable).toBe(true);
  });

  test("rejects inline attachment data before invoking a handler", async () => {
    let handlerCalled = false;
    const handler: ChannelRequestHandler = {
      async handle() {
        handlerCalled = true;
        return { accepted: true };
      },
    };
    const runtimeDirectory = await testDirectory();
    const lane = new LaneServer({ laneId: "lane-a", runtimeDirectory, handler });
    await lane.start();
    cleanups.push(() => lane.stop());
    const client = await RpcClient.connect(lane.socketPath);
    await client.request(registration());

    const response = await client.request({
      jsonrpc: "2.0",
      id: "message-inline",
      method: "channel.message.received",
      params: {
        driver_instance_id: "discord-main-1",
        attachments: [{ filename: "x", base64: "eA==" }],
      },
    });
    expect("error" in response && response.error.code).toBe(-32043);
    expect(handlerCalled).toBe(false);
  });

  test("binds requests to the registered driver identity", async () => {
    let handlerCalled = false;
    const handler: ChannelRequestHandler = {
      async handle() {
        handlerCalled = true;
        return { accepted: true };
      },
    };
    const runtimeDirectory = await testDirectory();
    const lane = new LaneServer({ laneId: "lane-a", runtimeDirectory, handler });
    await lane.start();
    cleanups.push(() => lane.stop());
    const client = await RpcClient.connect(lane.socketPath);
    await client.request(registration());

    const response = await client.request({
      jsonrpc: "2.0",
      id: "message-spoofed",
      method: "channel.message.received",
      params: { driver_instance_id: "another-driver", attachments: [] },
    });
    expect("error" in response && response.error.data?.code).toBe(
      "DRIVER_INSTANCE_MISMATCH",
    );
    expect(handlerCalled).toBe(false);
  });

  test("rejects requests without an identity-bearing params object", async () => {
    let handlerCalled = false;
    const handler: ChannelRequestHandler = {
      async handle() {
        handlerCalled = true;
        return { accepted: true };
      },
    };
    const runtimeDirectory = await testDirectory();
    const lane = new LaneServer({ laneId: "lane-a", runtimeDirectory, handler });
    await lane.start();
    cleanups.push(() => lane.stop());
    const client = await RpcClient.connect(lane.socketPath);
    await client.request(registration());

    const response = await client.request({
      jsonrpc: "2.0",
      id: "message-no-params",
      method: "channel.message.received",
    });
    expect("error" in response && response.error.data?.code).toBe(
      "INVALID_PARAMS",
    );
    expect(handlerCalled).toBe(false);
  });
});

describe("HostDaemon", () => {
  test("owns one control socket and exposes multiple lanes", async () => {
    const runtimeDirectory = await testDirectory();
    const daemon = new HostDaemon({ runtimeDirectory });
    await daemon.start(["lane-a", "lane-b"]);
    cleanups.push(() => daemon.stop());

    const status = await probeHostDaemon(runtimeDirectory);
    expect(status?.running).toBe(true);
    expect(status?.lanes.map((lane) => lane.lane_id).sort()).toEqual([
      "lane-a",
      "lane-b",
    ]);

    const second = new HostDaemon({ runtimeDirectory });
    await expect(second.start()).rejects.toThrow("already running");
  });
});
