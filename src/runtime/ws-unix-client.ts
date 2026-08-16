import { createConnection, type Socket } from "node:net";
import { createHash, randomBytes } from "node:crypto";

/**
 * A WebSocket client for the Codex app-server's unix transport.
 *
 * `codex app-server --listen unix://PATH` does not speak NDJSON over that
 * socket the way `stdio://` does. It serves a WebSocket at `/rpc` and carries
 * the same JSON-RPC inside text frames. Connecting with raw JSON gets the
 * connection closed with no error, which is what makes the transport look
 * broken rather than misunderstood.
 *
 * Hand-rolled rather than `Bun.WebSocket` because Bun always advertises
 * `Sec-WebSocket-Extensions: permessage-deflate`, and this server closes the
 * connection instead of declining the extension. The `codex` TUI sends no
 * extension header, so neither does this. Every other difference from a full
 * client is deliberate too: no compression, no subprotocols, no continuation
 * of interleaved control frames -- the peer is one known program.
 */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface WsUnixConnection {
  send(payload: string): void;
  close(): void;
  readonly closed: Promise<void>;
}

export interface WsUnixHandlers {
  onMessage: (payload: string) => void;
  onClose: (reason: string) => void;
}

interface Frame {
  opcode: number;
  payload: Buffer;
  fin: boolean;
}

/** Client frames must be masked (RFC 6455 § 5.3); servers reject unmasked ones. */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index]! ^ mask[index % 4]!;
  }
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | length])
      : length < 65_536
        ? Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff])
        : (() => {
            const buffer = Buffer.alloc(10);
            buffer[0] = 0x80 | opcode;
            buffer[1] = 0x80 | 127;
            buffer.writeBigUInt64BE(BigInt(length), 2);
            return buffer;
          })();
  return Buffer.concat([header, mask, masked]);
}

/** Returns null when `buffer` does not yet hold a whole frame. */
function decodeFrame(buffer: Buffer): { frame: Frame; rest: Buffer } | null {
  if (buffer.length < 2) return null;
  const fin = (buffer[0]! & 0x80) !== 0;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame is too large");
    length = Number(big);
    offset += 8;
  }
  // A server must not mask, but decoding it costs four bytes of care and
  // saves a silent garbage payload if one ever does.
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = payload[index]! ^ mask[index % 4]!;
    }
  }
  return { frame: { opcode, payload, fin }, rest: buffer.subarray(offset + length) };
}

export async function connectWsUnix(
  socketPath: string,
  requestPath: string,
  handlers: WsUnixHandlers,
): Promise<WsUnixConnection> {
  const key = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1").update(`${key}${GUID}`).digest("base64");
  const socket: Socket = createConnection(socketPath);
  socket.setNoDelay(true);

  let closeResolve: (() => void) | null = null;
  const closed = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });

  await new Promise<void>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onHandshakeData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = buffer.subarray(0, end).toString("latin1");
      socket.off("data", onHandshakeData);
      socket.off("error", onHandshakeError);
      if (!/^HTTP\/1\.1 101/i.test(head)) {
        socket.destroy();
        reject(new Error(`app-server refused the WebSocket upgrade: ${head.split("\r\n")[0]}`));
        return;
      }
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
      if (accept !== expectedAccept) {
        socket.destroy();
        reject(new Error("app-server returned a mismatched Sec-WebSocket-Accept"));
        return;
      }
      attach(buffer.subarray(end + 4));
      resolve();
    };
    const onHandshakeError = (error: Error) => {
      socket.off("data", onHandshakeData);
      reject(error);
    };
    socket.once("connect", () => {
      // No Sec-WebSocket-Extensions: advertising permessage-deflate is what
      // makes this server hang up. Header set matches the codex TUI's.
      socket.write(
        `GET ${requestPath} HTTP/1.1\r\n` +
          "Host: localhost\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n\r\n`,
      );
    });
    socket.on("data", onHandshakeData);
    socket.once("error", onHandshakeError);
  });

  function attach(initial: Buffer): void {
    let buffer = initial;
    // Text messages arrive fragmented once they are large enough, and the
    // app-server's model listings are.
    let assembling: Buffer[] = [];
    const finish = (reason: string) => {
      if (!closeResolve) return;
      const resolveClose = closeResolve;
      closeResolve = null;
      handlers.onClose(reason);
      resolveClose();
    };
    const pump = () => {
      for (;;) {
        const decoded = decodeFrame(buffer);
        if (!decoded) return;
        buffer = decoded.rest;
        const { opcode, payload, fin } = decoded.frame;
        if (opcode === 0x8) {
          socket.write(encodeFrame(0x8, Buffer.alloc(0)));
          socket.end();
          finish("app-server closed the connection");
          return;
        }
        if (opcode === 0x9) {
          socket.write(encodeFrame(0xa, payload));
          continue;
        }
        if (opcode === 0xa) continue;
        assembling.push(payload);
        if (!fin) continue;
        const message = Buffer.concat(assembling).toString("utf8");
        assembling = [];
        handlers.onMessage(message);
      }
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        pump();
      } catch (error) {
        socket.destroy();
        finish(error instanceof Error ? error.message : String(error));
      }
    });
    socket.on("error", (error) => finish(error.message));
    socket.on("close", () => finish("app-server socket closed"));
    pump();
  }

  return {
    send(payload: string): void {
      socket.write(encodeFrame(0x1, Buffer.from(payload, "utf8")));
    },
    close(): void {
      if (socket.destroyed) return;
      socket.write(encodeFrame(0x8, Buffer.alloc(0)));
      socket.end();
    },
    closed,
  };
}

/**
 * The threads an app-server currently has in memory, newest last.
 *
 * `thread/list` answers with saved sessions, which is a different set: a
 * thread the daemon is driving right now may not be in it, and a thread from
 * last week will be. Only `thread/loaded/list` reports what is live, and that
 * is what an operator attaching wants to look at.
 *
 * Returns [] rather than throwing, since this is used to decide whether a
 * viewer can be pointed at something -- and if it cannot, it still opens.
 */
export async function loadedThreadIds(socketPath: string): Promise<string[]> {
  let resolveIds: (ids: string[]) => void = () => undefined;
  const answered = new Promise<string[]>((resolve) => {
    resolveIds = resolve;
  });
  let connection: WsUnixConnection | null = null;
  try {
    connection = await connectWsUnix(socketPath, "/rpc", {
      onMessage: (payload) => {
        const message = JSON.parse(payload) as {
          id?: unknown;
          result?: { data?: unknown };
        };
        if (message.id !== "loaded") return;
        const data = message.result?.data;
        resolveIds(Array.isArray(data) ? data.filter((id): id is string => typeof id === "string") : []);
      },
      onClose: () => resolveIds([]),
    });
    connection.send(JSON.stringify({
      id: "initialize",
      method: "initialize",
      params: {
        clientInfo: { name: "agent_mesh_client", title: "Agent Mesh Client", version: "0.1.0" },
        capabilities: null,
      },
    }));
    connection.send(JSON.stringify({ method: "initialized", params: {} }));
    connection.send(JSON.stringify({ id: "loaded", method: "thread/loaded/list", params: {} }));
    return await Promise.race([
      answered,
      new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 5_000)),
    ]);
  } catch {
    return [];
  } finally {
    connection?.close();
  }
}
