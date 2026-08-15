export const LOCAL_CHANNEL_PROTOCOL_VERSION = "0.1" as const;

export const MAX_FRAME_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_EVENT = 32;
export const MAX_ATTACHMENT_TOTAL_BYTES = 256 * 1024 * 1024;

export const DEFAULT_SUPPORTED_CAPABILITIES = [
  "message.receive",
  "message.send",
] as const;

/**
 * Local channel RPC error codes, in the half of the JSON-RPC
 * implementation-defined range that the mesh contract promises never to
 * allocate: `-32099 … -32050` (contracts v0.7.5, SPEC § 8).
 *
 * These began at -32040 and collided with five mesh audit codes. Nothing broke
 * loudly, because that is not how this fails — both vocabularies are JSON-RPC
 * and they meet inside one process, so a shared number does not error, it
 * reclassifies. `-32043` meant "this attachment is permanently malformed" here
 * and "the Hub is busy, retry" there.
 */
export const CHANNEL_ERROR_CODES = {
  NOT_REGISTERED: -32050,
  PROTOCOL_UNSUPPORTED: -32051,
  CAPABILITY_UNSUPPORTED: -32052,
  ATTACHMENT_INVALID: -32053,
  DURABILITY_FAILED: -32054,
  BACKPRESSURE: -32055,
  PROVIDER_FAILED: -32056,
} as const;
