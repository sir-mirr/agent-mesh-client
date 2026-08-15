import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import {
  controlSocketPath,
  ensurePrivateRuntimeDirectory,
} from "../config/paths";
import {
  LaneServer,
  type ChannelRequestHandler,
  type LaneServerOptions,
} from "../channel-rpc/lane-server";
import {
  failure,
  parseJsonRpcRequest,
  success,
  type JsonRpcRequest,
} from "../channel-rpc/json-rpc";
import { encodeFrame, NdjsonDecoder } from "../channel-rpc/ndjson";

export interface HostDaemonOptions {
  runtimeDirectory: string;
  onDiagnostic?: LaneServerOptions["onDiagnostic"];
  createLaneHandler?: (laneId: string) => ChannelRequestHandler | undefined;
  onControlRequest?: (request: JsonRpcRequest) => Promise<unknown>;
}

export interface HostDaemonStatus {
  running: true;
  pid: number;
  runtime_directory: string;
  lanes: Array<{
    lane_id: string;
    socket_path: string;
    active_drivers: number;
  }>;
}

async function probeSocket(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}

async function removeStaleControlSocket(path: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isSocket()) {
    throw new Error(`Refusing to replace non-socket control path: ${path}`);
  }
  if (await probeSocket(path)) {
    throw new Error(`Another agent-mesh daemon is already running at ${path}`);
  }
  await unlink(path);
}

export class HostDaemon {
  readonly runtimeDirectory: string;
  readonly controlPath: string;
  readonly #onDiagnostic: LaneServerOptions["onDiagnostic"];
  readonly #createLaneHandler:
    | ((laneId: string) => ChannelRequestHandler | undefined)
    | undefined;
  readonly #onControlRequest:
    | ((request: JsonRpcRequest) => Promise<unknown>)
    | undefined;
  readonly #lanes = new Map<string, LaneServer>();
  #controlServer: Server | null = null;

  constructor(options: HostDaemonOptions) {
    this.runtimeDirectory = options.runtimeDirectory;
    this.controlPath = controlSocketPath(options.runtimeDirectory);
    this.#onDiagnostic = options.onDiagnostic;
    this.#createLaneHandler = options.createLaneHandler;
    this.#onControlRequest = options.onControlRequest;
  }

  get status(): HostDaemonStatus {
    return {
      running: true,
      pid: process.pid,
      runtime_directory: this.runtimeDirectory,
      lanes: [...this.#lanes.values()].map((lane) => ({
        lane_id: lane.laneId,
        socket_path: lane.socketPath,
        active_drivers: lane.activeDriverCount,
      })),
    };
  }

  getLane(laneId: string): LaneServer | null {
    return this.#lanes.get(laneId) ?? null;
  }

  async start(laneIds: readonly string[] = []): Promise<void> {
    if (this.#controlServer) throw new Error("Host daemon is already started");
    await ensurePrivateRuntimeDirectory(this.runtimeDirectory);
    await removeStaleControlSocket(this.controlPath);

    const server = createServer((socket) => {
      const decoder = new NdjsonDecoder();
      let processing = Promise.resolve();
      socket.on("data", (chunk) => {
        let frames: unknown[];
        try {
          frames = decoder.push(
            typeof chunk === "string" ? Buffer.from(chunk) : chunk,
          );
        } catch {
          socket.destroy();
          return;
        }
        for (const frame of frames) {
          processing = processing.then(async () => {
            let request: JsonRpcRequest;
            try {
              request = parseJsonRpcRequest(frame);
            } catch (error) {
              socket.write(encodeFrame(failure(null, error)));
              return;
            }
            try {
              const result =
                request.method === "daemon.status"
                  ? this.status
                  : await this.#onControlRequest?.(request);
              if (result === undefined) {
                throw new Error(`Unsupported control method: ${request.method}`);
              }
              socket.write(encodeFrame(success(request.id, result)));
            } catch (error) {
              socket.write(encodeFrame(failure(request.id, error)));
            }
          });
        }
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.controlPath);
    });
    await chmod(this.controlPath, 0o600);
    this.#controlServer = server;

    try {
      for (const laneId of new Set(laneIds)) await this.addLane(laneId);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async addLane(laneId: string): Promise<LaneServer> {
    if (!this.#controlServer) throw new Error("Host daemon is not started");
    if (this.#lanes.has(laneId)) {
      throw new Error(`Lane is already active: ${laneId}`);
    }
    const handler = this.#createLaneHandler?.(laneId);
    const options: LaneServerOptions = {
      laneId,
      runtimeDirectory: this.runtimeDirectory,
    };
    if (this.#onDiagnostic) options.onDiagnostic = this.#onDiagnostic;
    if (handler) options.handler = handler;
    const lane = new LaneServer(options);
    await lane.start();
    this.#lanes.set(laneId, lane);
    return lane;
  }

  async removeLane(laneId: string): Promise<void> {
    const lane = this.#lanes.get(laneId);
    if (!lane) return;
    this.#lanes.delete(laneId);
    await lane.stop();
  }

  async stop(): Promise<void> {
    const laneStops = [...this.#lanes.values()].map((lane) => lane.stop());
    this.#lanes.clear();
    await Promise.allSettled(laneStops);

    const server = this.#controlServer;
    this.#controlServer = null;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    try {
      await unlink(this.controlPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function probeHostDaemon(
  runtimeDirectory: string,
): Promise<HostDaemonStatus | null> {
  const path = controlSocketPath(runtimeDirectory);
  try {
    return (await requestControl(runtimeDirectory, "daemon.status")) as HostDaemonStatus;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED") return null;
    throw error;
  }
}

export async function requestControl(
  runtimeDirectory: string,
  method: string,
  params?: unknown,
): Promise<unknown> {
  const path = controlSocketPath(runtimeDirectory);
  return await new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(path);
    const decoder = new NdjsonDecoder();
    socket.once("connect", () => {
      const request: Record<string, unknown> = {
        jsonrpc: "2.0",
        id: `ctrl-${process.pid}-${Date.now()}`,
        method,
      };
      if (params !== undefined) request.params = params;
      socket.write(encodeFrame(request));
    });
    socket.on("data", (chunk) => {
      try {
        const [response] = decoder.push(
          typeof chunk === "string" ? Buffer.from(chunk) : chunk,
        );
        if (!response || typeof response !== "object") return;
        socket.end();
        if ("error" in response) {
          reject(new Error(JSON.stringify(response.error)));
        } else if ("result" in response) {
          resolve(response.result);
        }
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}
