import { describe, expect, test } from "bun:test";
import { MAX_FRAME_BYTES } from "../src/constants";
import {
  FrameTooLargeError,
  InvalidFrameError,
  NdjsonDecoder,
  encodeFrame,
} from "../src/channel-rpc/ndjson";

describe("NDJSON framing", () => {
  test("reassembles split UTF-8 frames", () => {
    const decoder = new NdjsonDecoder();
    const encoded = Buffer.from('{"text":"안녕하세요"}\n', "utf8");
    const splitAt = encoded.indexOf(Buffer.from("안", "utf8")) + 1;

    expect(decoder.push(encoded.subarray(0, splitAt))).toEqual([]);
    expect(decoder.push(encoded.subarray(splitAt))).toEqual([
      { text: "안녕하세요" },
    ]);
  });

  test("accepts a document exactly at the 10 MiB limit", () => {
    const decoder = new NdjsonDecoder();
    const document = Buffer.from(
      `"${"a".repeat(MAX_FRAME_BYTES - 2)}"`,
      "utf8",
    );
    const [value] = decoder.push(Buffer.concat([document, Buffer.from("\n")]));
    expect(Buffer.byteLength(value as string, "utf8")).toBe(
      MAX_FRAME_BYTES - 2,
    );
  });

  test("rejects a frame one byte over the configured limit", () => {
    const decoder = new NdjsonDecoder(16);
    expect(() => decoder.push(Buffer.alloc(17, 0x61))).toThrow(
      FrameTooLargeError,
    );
  });

  test("rejects malformed UTF-8 and JSON", () => {
    expect(() =>
      new NdjsonDecoder().push(Buffer.from([0xff, 0x0a])),
    ).toThrow(InvalidFrameError);
    expect(() =>
      new NdjsonDecoder().push(Buffer.from("{bad}\n")),
    ).toThrow(InvalidFrameError);
  });

  test("enforces the outbound byte limit without counting LF", () => {
    expect(encodeFrame("1234", 6).byteLength).toBe(7);
    expect(() => encodeFrame("12345", 6)).toThrow(FrameTooLargeError);
  });
});
