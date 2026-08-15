import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import {
  CHANNEL_ERROR_CODES,
  DEFAULT_SUPPORTED_CAPABILITIES,
} from "../constants";
import {
  ensurePrivateRuntimeDirectory,
  laneSocketPath,
} from "../config/paths";
import {
  ChannelRpcError,
  failure,
  parseJsonRpcRequest,
  success,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./json-rpc";
import {
  FrameTooLargeError,
  InvalidFrameError,
  NdjsonDecoder,
  encodeFrame,
} from "./ndjson";
import {
  parseRegistration,
  type ChannelRegistration,
} from "./registration";
import { prefixedId } from "../util/ids";

export interface RegisteredDriver {
  laneId: string;
  registration: ChannelRegistration;
}

export interface ChannelRequestHandler {
  handle(driver: RegisteredDriver, request: JsonRpcRequest): Promise<unknown>;
}

export interface LaneServerOptions {
  laneId: string;
  runtimeDirectory: string;
  supportedCapabilities?: readonly string[];
  handler?: ChannelRequestHandler;
  onDiagnostic?: (message: string, error?: unknown) => void;
}

interface DriverConnection {
  socket: Socket;
  registration: ChannelRegistration | null;
  processing: Promise<void>;
  pending: Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
}

const INLINE_ATTACHMENT_KEYS = new Set([
  "base64",
  "bytes",
  "content_base64",
  "data",
]);

class FailClosedHandler implements ChannelRequestHandler {
  async handle(_driver: RegisteredDriver, request: JsonRpcRequest): Promise<never> {
    if (request.method === "channel.message.received") {
      throw new ChannelRpcError({
        rpcCode: CHANNEL_ERROR_CODES.DURABILITY_FAILED,
        dataCode: "CHANNEL_DURABILITY_FAILED",
        message: "Durable inbound storage is unavailable",
        retryable: true,
      });
    }
    throw new ChannelRpcError({
      rpcCode: -32601,
      dataCode: "METHOD_NOT_SUPPORTED",
      message: `Unsupported channel method: ${request.method}`,
    });
  }
}

function containsInlineAttachmentData(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsInlineAttachmentData);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      INLINE_ATTACHMENT_KEYS.has(key.toLowerCase()) ||
      containsInlineAttachmentData(child),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRegisteredRequest(
  registration: ChannelRegistration,
  request: JsonRpcRequest,
): void {
  if (!isRecord(request.params)) {
    throw new ChannelRpcError({
      rpcCode: -32602,
      dataCode: "INVALID_PARAMS",
      message: "Channel request params must be an object",
    });
  }

  const claimedInstanceId = request.params.driver_instance_id;
  if (claimedInstanceId !== registration.driverInstanceId) {
    throw new ChannelRpcError({
      rpcCode: -32602,
      dataCode: "DRIVER_INSTANCE_MISMATCH",
      message: "driver_instance_id is required and must match the registered connection",
    });
  }

  const capability =
    {
      "channel.message.received": "message.receive",
      "channel.reaction.received": "reaction.receive",
      "channel.message.updated": "message.update",
      "channel.message.deleted": "message.delete",
    }[request.method] ?? null;
  if (capability && !registration.capabilities.includes(capability)) {
    throw new ChannelRpcError({
      rpcCode: CHANNEL_ERROR_CODES.CAPABILITY_UNSUPPORTED,
      dataCode: "CHANNEL_CAPABILITY_UNSUPPORTED",
      message: `Channel capability was not negotiated: ${capability}`,
    });
  }

  if (containsInlineAttachmentData(request.params.attachments)) {
    throw new ChannelRpcError({
      rpcCode: CHANNEL_ERROR_CODES.ATTACHMENT_INVALID,
      dataCode: "CHANNEL_ATTACHMENT_INVALID",
      message: "Attachment bytes or base64 are forbidden in Channel RPC",
    });
  }
}

async function writeFrame(socket: Socket, value: unknown): Promise<void> {
  const frame = encodeFrame(value);
  await new Promise<void>((resolve, reject) => {
    socket.write(frame, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function writeResponse(socket: Socket, response: JsonRpcResponse): Promise<void> {
  await writeFrame(socket, response);
}

export class DriverRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "DriverRpcError";
  }
}

async function socketHasListener(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const probe = createConnection(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        resolve(false);
      } else {
        reject(error);
      }
    });
  });
}

async function removeStaleSocket(path: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isSocket()) {
    throw new Error(`Refusing to replace non-socket path: ${path}`);
  }
  if (await socketHasListener(path)) {
    throw new Error(`Socket already has an active listener: ${path}`);
  }
  await unlink(path);
}

export class LaneServer {
  readonly laneId: string;
  readonly socketPath: string;
  readonly #supportedCapabilities: readonly string[];
  readonly #handler: ChannelRequestHandler;
  readonly #onDiagnostic: (message: string, error?: unknown) => void;
  readonly #drivers = new Map<string, DriverConnection>();
  #server: Server | null = null;

  constructor(options: LaneServerOptions) {
    this.laneId = options.laneId;
    this.socketPath = laneSocketPath(options.runtimeDirectory, options.laneId);
    this.#supportedCapabilities =
      options.supportedCapabilities ?? DEFAULT_SUPPORTED_CAPABILITIES;
    this.#handler = options.handler ?? new FailClosedHandler();
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
  }

  get activeDriverCount(): number {
    return this.#drivers.size;
  }

  getDriver(driverInstanceId: string): ChannelRegistration | null {
    return this.#drivers.get(driverInstanceId)?.registration ?? null;
  }

  listDrivers(): ChannelRegistration[] {
    return [...this.#drivers.values()]
      .map((driver) => driver.registration)
      .filter((value): value is ChannelRegistration => value !== null);
  }

  async requestDriver(
    driverInstanceId: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMilliseconds = 30_000,
  ): Promise<unknown> {
    const connection = this.#drivers.get(driverInstanceId);
    if (!connection?.registration || connection.socket.destroyed) {
      throw new DriverRpcError(
        CHANNEL_ERROR_CODES.PROVIDER_FAILED,
        `Channel driver is not connected: ${driverInstanceId}`,
      );
    }
    const requiredCapability =
      method === "channel.message.send" ? "message.send" : null;
    if (
      requiredCapability &&
      !connection.registration.capabilities.includes(requiredCapability)
    ) {
      throw new DriverRpcError(
        CHANNEL_ERROR_CODES.CAPABILITY_UNSUPPORTED,
        `Channel driver did not negotiate ${requiredCapability}`,
      );
    }
    const id = prefixedId("rpc");
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id);
        reject(
          new DriverRpcError(
            CHANNEL_ERROR_CODES.PROVIDER_FAILED,
            `Channel driver request timed out: ${method}`,
          ),
        );
      }, timeoutMilliseconds);
      connection.pending.set(id, { resolve, reject, timer });
    });
    try {
      await writeFrame(connection.socket, {
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
    } catch (error) {
      const pending = connection.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        connection.pending.delete(id);
      }
      throw error;
    }
    return await result;
  }

  async start(): Promise<void> {
    if (this.#server) throw new Error(`Lane is already started: ${this.laneId}`);
    const runtimeDirectory = this.socketPath.slice(
      0,
      this.socketPath.lastIndexOf("/"),
    );
    await ensurePrivateRuntimeDirectory(runtimeDirectory);
    await removeStaleSocket(this.socketPath);

    const server = createServer((socket) => this.#accept(socket));
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
      server.listen(this.socketPath);
    });
    await chmod(this.socketPath, 0o600);
    this.#server = server;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = null;
    for (const connection of this.#drivers.values()) {
      connection.socket.destroy();
    }
    this.#drivers.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    try {
      await unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  #accept(socket: Socket): void {
    const decoder = new NdjsonDecoder();
    const connection: DriverConnection = {
      socket,
      registration: null,
      processing: Promise.resolve(),
      pending: new Map(),
    };

    socket.on("data", (chunk) => {
      let frames: unknown[];
      try {
        frames = decoder.push(
          typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
        );
      } catch (error) {
        if (error instanceof FrameTooLargeError) {
          this.#onDiagnostic("Channel frame exceeded the 10 MiB limit", error);
          socket.destroy();
          return;
        }
        const frameError =
          error instanceof InvalidFrameError
            ? new ChannelRpcError({
                rpcCode: -32700,
                dataCode: "PARSE_ERROR",
                message: error.message,
                closeConnection: true,
              })
            : error;
        connection.processing = connection.processing
          .then(async () => {
            await writeResponse(socket, failure(null, frameError));
            socket.end();
          })
          .catch((writeError) => {
            socket.destroy(writeError as Error);
          });
        return;
      }

      for (const frame of frames) {
        connection.processing = connection.processing
          .then(() => this.#process(connection, frame))
          .catch((error) => {
            this.#onDiagnostic("Unhandled channel connection error", error);
            socket.destroy();
          });
      }
    });

    socket.on("error", (error) => {
      this.#onDiagnostic("Channel connection error", error);
    });
    socket.on("close", () => {
      for (const pending of connection.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new DriverRpcError(
            CHANNEL_ERROR_CODES.PROVIDER_FAILED,
            "Channel driver disconnected",
          ),
        );
      }
      connection.pending.clear();
      const instanceId = connection.registration?.driverInstanceId;
      if (instanceId && this.#drivers.get(instanceId) === connection) {
        this.#drivers.delete(instanceId);
      }
    });
  }

  async #process(connection: DriverConnection, frame: unknown): Promise<void> {
    if (isRecord(frame) && typeof frame.id === "string" && !("method" in frame)) {
      const pending = connection.pending.get(frame.id);
      if (!pending) return;
      connection.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (isRecord(frame.error)) {
        pending.reject(
          new DriverRpcError(
            typeof frame.error.code === "number"
              ? frame.error.code
              : CHANNEL_ERROR_CODES.PROVIDER_FAILED,
            typeof frame.error.message === "string"
              ? frame.error.message
              : "Channel driver request failed",
            frame.error.data,
          ),
        );
      } else pending.resolve(frame.result);
      return;
    }
    let request: JsonRpcRequest;
    try {
      request = parseJsonRpcRequest(frame);
    } catch (error) {
      await writeResponse(connection.socket, failure(null, error));
      connection.socket.end();
      return;
    }

    try {
      if (!connection.registration) {
        if (request.method !== "channel.register") {
          throw new ChannelRpcError({
            rpcCode: CHANNEL_ERROR_CODES.NOT_REGISTERED,
            dataCode: "CHANNEL_NOT_REGISTERED",
            message: "First channel request must be channel.register",
            closeConnection: true,
          });
        }
        const parsed = parseRegistration(
          request.params,
          this.laneId,
          this.#supportedCapabilities,
        );
        connection.registration = parsed.registration;
        const previous = this.#drivers.get(
          parsed.registration.driverInstanceId,
        );
        this.#drivers.set(parsed.registration.driverInstanceId, connection);
        if (previous && previous !== connection) previous.socket.end();
        await writeResponse(connection.socket, success(request.id, parsed.result));
        return;
      }

      if (request.method === "channel.register") {
        throw new ChannelRpcError({
          rpcCode: -32600,
          dataCode: "ALREADY_REGISTERED",
          message: "Connection is already registered",
          closeConnection: true,
        });
      }
      assertRegisteredRequest(connection.registration, request);
      const result = await this.#handler.handle(
        { laneId: this.laneId, registration: connection.registration },
        request,
      );
      await writeResponse(connection.socket, success(request.id, result));
    } catch (error) {
      await writeResponse(connection.socket, failure(request.id, error));
      if (error instanceof ChannelRpcError && error.closeConnection) {
        connection.socket.end();
      }
    }
  }
}
