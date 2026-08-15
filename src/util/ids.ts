import { randomBytes } from "node:crypto";

let lastTimestamp = 0;
let sequence = 0;

export function uuidV7(now = Date.now()): string {
  if (now === lastTimestamp) sequence = (sequence + 1) & 0x0fff;
  else {
    lastTimestamp = now;
    sequence = randomBytes(2).readUInt16BE(0) & 0x0fff;
  }

  const bytes = randomBytes(16);
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function prefixedId(prefix: string): string {
  return `${prefix}_${uuidV7()}`;
}
