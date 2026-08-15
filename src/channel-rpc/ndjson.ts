import { MAX_FRAME_BYTES } from "../constants";

export class FrameTooLargeError extends Error {
  constructor(readonly frameBytes: number, readonly maxFrameBytes: number) {
    super(`NDJSON frame is ${frameBytes} bytes; maximum is ${maxFrameBytes}`);
    this.name = "FrameTooLargeError";
  }
}

export class InvalidFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFrameError";
  }
}

export class NdjsonDecoder {
  #buffer = Buffer.alloc(0);
  readonly #maxFrameBytes: number;

  constructor(maxFrameBytes = MAX_FRAME_BYTES) {
    this.#maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength === 0) return [];

    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const values: unknown[] = [];

    while (true) {
      const delimiter = this.#buffer.indexOf(0x0a);
      if (delimiter === -1) {
        if (this.#buffer.byteLength > this.#maxFrameBytes) {
          throw new FrameTooLargeError(
            this.#buffer.byteLength,
            this.#maxFrameBytes,
          );
        }
        return values;
      }

      const frame = this.#buffer.subarray(0, delimiter);
      this.#buffer = this.#buffer.subarray(delimiter + 1);
      if (frame.byteLength > this.#maxFrameBytes) {
        throw new FrameTooLargeError(frame.byteLength, this.#maxFrameBytes);
      }
      if (frame.byteLength === 0) {
        throw new InvalidFrameError("Empty NDJSON frame");
      }

      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
      } catch {
        throw new InvalidFrameError("NDJSON frame is not valid UTF-8");
      }

      try {
        values.push(JSON.parse(text));
      } catch {
        throw new InvalidFrameError("NDJSON frame is not valid JSON");
      }
    }
  }
}

export function encodeFrame(
  value: unknown,
  maxFrameBytes = MAX_FRAME_BYTES,
): Buffer {
  const document = Buffer.from(JSON.stringify(value), "utf8");
  if (document.byteLength > maxFrameBytes) {
    throw new FrameTooLargeError(document.byteLength, maxFrameBytes);
  }
  return Buffer.concat([document, Buffer.from("\n")]);
}
