import { CHANNEL_ERROR_CODES } from "../constants";
import type {
  ChannelRequestHandler,
  RegisteredDriver,
} from "../channel-rpc/lane-server";
import { ChannelRpcError, type JsonRpcRequest } from "../channel-rpc/json-rpc";
import {
  AttachmentValidationError,
} from "../outbox/blob-spool";
import { LaneOutbox, OutboxCapacityError } from "../outbox/lane-outbox";
import type { StagedAttachment, StoredAuditEvent } from "../outbox/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ChannelRpcError({
      rpcCode: -32602,
      dataCode: "INVALID_PARAMS",
      message: `channel.message.received requires ${key}`,
    });
  }
  return value;
}

function parseAttachments(value: unknown): StagedAttachment[] {
  if (!Array.isArray(value)) {
    throw new ChannelRpcError({
      rpcCode: -32602,
      dataCode: "INVALID_PARAMS",
      message: "attachments must be an array",
    });
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new ChannelRpcError({
        rpcCode: -32602,
        dataCode: "INVALID_PARAMS",
        message: "attachment metadata must be an object",
      });
    }
    const size = item.size;
    if (!Number.isSafeInteger(size)) {
      throw new ChannelRpcError({
        rpcCode: -32602,
        dataCode: "INVALID_PARAMS",
        message: "attachment size must be an integer",
      });
    }
    return {
      attachment_id: requiredString(item, "attachment_id"),
      filename: requiredString(item, "filename"),
      media_type: requiredString(item, "media_type"),
      size: size as number,
      sha256: requiredString(item, "sha256"),
      local_path: requiredString(item, "local_path"),
    };
  });
}

export interface DurableChannelHandlerOptions {
  onAccepted?: (event: StoredAuditEvent) => void | Promise<void>;
}

export class DurableChannelHandler implements ChannelRequestHandler {
  readonly #onAccepted: DurableChannelHandlerOptions["onAccepted"];

  constructor(
    readonly outbox: LaneOutbox,
    options: DurableChannelHandlerOptions = {},
  ) {
    this.#onAccepted = options.onAccepted;
  }

  async handle(driver: RegisteredDriver, request: JsonRpcRequest): Promise<unknown> {
    if (request.method !== "channel.message.received") {
      throw new ChannelRpcError({
        rpcCode: -32601,
        dataCode: "METHOD_NOT_SUPPORTED",
        message: `Unsupported channel method: ${request.method}`,
      });
    }
    if (!isRecord(request.params)) {
      throw new ChannelRpcError({
        rpcCode: -32602,
        dataCode: "INVALID_PARAMS",
        message: "channel.message.received params must be an object",
      });
    }

    const providerEventId = requiredString(request.params, "provider_event_id");
    const providerMessageId = requiredString(request.params, "provider_message_id");
    const conversation = request.params.conversation;
    if (!isRecord(conversation)) {
      throw new ChannelRpcError({
        rpcCode: -32602,
        dataCode: "INVALID_PARAMS",
        message: "conversation must be an object",
      });
    }
    const accountRef = requiredString(conversation, "account_ref");
    const conversationRef = requiredString(conversation, "conversation_ref");
    const threadRef =
      typeof conversation.thread_ref === "string" ? conversation.thread_ref : null;
    const dedupKey = [
      driver.registration.driverInstanceId,
      accountRef,
      providerEventId,
    ].join("\u0000");
    const existing = this.outbox.findByDedupKey(dedupKey);
    if (existing) {
      return {
        accepted: true,
        inbound_id: existing.inboundId,
        audit_event_id: existing.eventId,
        duplicate: true,
      };
    }

    try {
      const event = await this.outbox.record({
        direction: "inbound",
        sourceKind: "channel",
        driverInstanceId: driver.registration.driverInstanceId,
        rawParams: request.params,
        attachments: parseAttachments(request.params.attachments),
        stagingRoot: driver.registration.stagingRoot,
        correlation: {
          source_kind: "channel",
          provider: driver.registration.provider,
          driver_instance_id: driver.registration.driverInstanceId,
          account_ref: accountRef,
          conversation_ref: conversationRef,
          thread_ref: threadRef,
          reply_to_provider_message_id: providerMessageId,
        },
        dedupKey,
      });
      await this.#onAccepted?.(event);
      return {
        accepted: true,
        inbound_id: event.inboundId,
        audit_event_id: event.eventId,
        duplicate: false,
      };
    } catch (error) {
      if (error instanceof AttachmentValidationError) {
        throw new ChannelRpcError({
          rpcCode: CHANNEL_ERROR_CODES.ATTACHMENT_INVALID,
          dataCode: "CHANNEL_ATTACHMENT_INVALID",
          message: error.message,
        });
      }
      if (error instanceof OutboxCapacityError) {
        throw new ChannelRpcError({
          rpcCode: CHANNEL_ERROR_CODES.BACKPRESSURE,
          dataCode: "CHANNEL_BACKPRESSURE",
          message: error.message,
          retryable: true,
          retryAfterMs: 60_000,
        });
      }
      if (error instanceof ChannelRpcError) throw error;
      throw new ChannelRpcError({
        rpcCode: CHANNEL_ERROR_CODES.DURABILITY_FAILED,
        dataCode: "CHANNEL_DURABILITY_FAILED",
        message: "Failed to commit channel message to durable storage",
        retryable: true,
      });
    }
  }
}
