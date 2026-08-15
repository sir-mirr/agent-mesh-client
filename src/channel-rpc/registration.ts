import { isAbsolute } from "node:path";
import {
  CHANNEL_ERROR_CODES,
  DEFAULT_SUPPORTED_CAPABILITIES,
  LOCAL_CHANNEL_PROTOCOL_VERSION,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_EVENT,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_FRAME_BYTES,
} from "../constants";
import { ChannelRpcError } from "./json-rpc";

export interface ChannelRegistration {
  protocolVersion: typeof LOCAL_CHANNEL_PROTOCOL_VERSION;
  laneId: string;
  driverInstanceId: string;
  provider: string;
  accountRef: string;
  stagingRoot: string;
  capabilities: string[];
}

export interface ChannelRegistrationResult {
  protocol_version: typeof LOCAL_CHANNEL_PROTOCOL_VERSION;
  max_frame_bytes: number;
  max_attachment_bytes: number;
  max_attachments_per_event: number;
  max_attachment_total_bytes: number;
  capabilities: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  params: Record<string, unknown>,
  key: string,
): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ChannelRpcError({
      rpcCode: -32602,
      dataCode: "INVALID_PARAMS",
      message: `channel.register requires ${key}`,
      closeConnection: true,
    });
  }
  return value;
}

export function parseRegistration(
  value: unknown,
  expectedLaneId: string,
  supportedCapabilities: readonly string[] = DEFAULT_SUPPORTED_CAPABILITIES,
): { registration: ChannelRegistration; result: ChannelRegistrationResult } {
  if (!isRecord(value)) {
    throw new ChannelRpcError({
      rpcCode: -32602,
      dataCode: "INVALID_PARAMS",
      message: "channel.register params must be an object",
      closeConnection: true,
    });
  }

  const protocolVersion = requireString(value, "protocol_version");
  if (protocolVersion !== LOCAL_CHANNEL_PROTOCOL_VERSION) {
    throw new ChannelRpcError({
      rpcCode: CHANNEL_ERROR_CODES.PROTOCOL_UNSUPPORTED,
      dataCode: "CHANNEL_PROTOCOL_UNSUPPORTED",
      message: `Unsupported channel protocol version: ${protocolVersion}`,
      closeConnection: true,
    });
  }

  const laneId = requireString(value, "lane_id");
  if (laneId !== expectedLaneId) {
    throw new ChannelRpcError({
      rpcCode: -32602,
      dataCode: "LANE_MISMATCH",
      message: "Registered lane does not match socket lane",
      closeConnection: true,
    });
  }

  const stagingRoot = requireString(value, "staging_root");
  if (!isAbsolute(stagingRoot)) {
    throw new ChannelRpcError({
      rpcCode: -32602,
      dataCode: "INVALID_PARAMS",
      message: "staging_root must be an absolute path",
      closeConnection: true,
    });
  }

  if (
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every(
      (capability): capability is string =>
        typeof capability === "string" && capability.length > 0,
    ) ||
    new Set(value.capabilities).size !== value.capabilities.length
  ) {
    throw new ChannelRpcError({
      rpcCode: -32602,
      dataCode: "INVALID_PARAMS",
      message: "capabilities must be a unique array of non-empty strings",
      closeConnection: true,
    });
  }

  const capabilities = value.capabilities.filter((capability) =>
    supportedCapabilities.includes(capability),
  );
  const registration: ChannelRegistration = {
    protocolVersion: LOCAL_CHANNEL_PROTOCOL_VERSION,
    laneId,
    driverInstanceId: requireString(value, "driver_instance_id"),
    provider: requireString(value, "provider"),
    accountRef: requireString(value, "account_ref"),
    stagingRoot,
    capabilities,
  };

  return {
    registration,
    result: {
      protocol_version: LOCAL_CHANNEL_PROTOCOL_VERSION,
      max_frame_bytes: MAX_FRAME_BYTES,
      max_attachment_bytes: MAX_ATTACHMENT_BYTES,
      max_attachments_per_event: MAX_ATTACHMENTS_PER_EVENT,
      max_attachment_total_bytes: MAX_ATTACHMENT_TOTAL_BYTES,
      capabilities,
    },
  };
}
