import {
  AUDIT_SCHEMA_VERSION,
  ERROR_CLASS,
  MESH_ERROR,
  deriveBlobKey,
  type AuditAttachmentRef,
  type PrepareBlobsResult,
} from "@agent-mesh/contracts";
import type { IdentityKeyManager } from "../identity/key-manager";
import type { LaneOutbox } from "../outbox/lane-outbox";
import type { StoredAuditEvent } from "../outbox/types";
import { HubRpcError, type MeshClient } from "./mesh-client";

interface RawAttachment {
  filename: string;
  media_type?: string;
  size: number;
  sha256: string;
}

class AuditHttpError extends Error {
  constructor(
    readonly status: number,
    readonly permanent: boolean,
  ) {
    super(`Blob upload failed with HTTP ${status}`);
    this.name = "AuditHttpError";
  }
}

function eventAttachments(event: StoredAuditEvent): RawAttachment[] {
  const params = JSON.parse(Buffer.from(event.rawParams).toString("utf8")) as {
    attachments?: unknown;
  };
  if (!Array.isArray(params.attachments)) return [];
  return params.attachments.filter(
    (item): item is RawAttachment =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as RawAttachment).filename === "string" &&
      typeof (item as RawAttachment).size === "number" &&
      typeof (item as RawAttachment).sha256 === "string",
  );
}

function retryDelay(attempt: number, operatorRequired: boolean): number {
  const base = operatorRequired ? 10 * 60_000 : 1_000;
  const maximum = operatorRequired ? 60 * 60_000 : 5 * 60_000;
  const exponential = Math.min(maximum, base * 2 ** Math.min(attempt, 16));
  return Math.floor(exponential * (0.8 + Math.random() * 0.4));
}

export interface AuditWorkerStatus {
  running: boolean;
  lastAckAt: string | null;
  lastError: string | null;
}

export class AuditWorker {
  readonly #abort = new AbortController();
  #loop: Promise<void> | null = null;
  #wake: (() => void) | null = null;
  #status: AuditWorkerStatus = {
    running: false,
    lastAckAt: null,
    lastError: null,
  };

  constructor(
    readonly outbox: LaneOutbox,
    readonly mesh: MeshClient,
    readonly keyManager: IdentityKeyManager,
  ) {}

  get status(): AuditWorkerStatus {
    return { ...this.#status };
  }

  start(): void {
    if (this.#loop) return;
    this.#status = { ...this.#status, running: true };
    this.#loop = this.#run();
  }

  poke(): void {
    this.#wake?.();
    this.#wake = null;
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    this.poke();
    await this.#loop;
    this.#loop = null;
    this.#status = { ...this.#status, running: false };
  }

  async #run(): Promise<void> {
    while (!this.#abort.signal.aborted) {
      let didWork = false;
      if (this.mesh.status.state === "connected" && this.mesh.status.audit) {
        for (const event of this.outbox.listDue()) {
          didWork = true;
          await this.#process(event);
          if (this.#abort.signal.aborted) break;
        }
      }
      if (!didWork) await this.#wait(1_000);
    }
  }

  async #process(event: StoredAuditEvent): Promise<void> {
    const resumeState =
      event.state === "RETRY_WAIT"
        ? event.resumeState
        : event.state === "PENDING_APPEND"
          ? "PENDING_APPEND"
          : "PENDING_BLOBS";
    try {
      if (resumeState === "PENDING_BLOBS") {
        await this.#uploadBlobs(event);
        this.outbox.markPendingAppend(event.eventId);
      }
      await this.#append(event);
      this.outbox.markAcked(event.eventId);
      this.#status = {
        ...this.#status,
        lastAckAt: new Date().toISOString(),
        lastError: null,
      };
    } catch (error) {
      const rpcError = error instanceof HubRpcError ? error : null;
      const httpError = error instanceof AuditHttpError ? error : null;
      const classification = rpcError
        ? ERROR_CLASS[rpcError.code]
        : httpError?.permanent
          ? "permanent"
          : "transient";
      const errorCode = rpcError
        ? String(rpcError.code)
        : httpError
          ? `HTTP_${httpError.status}`
          : "NETWORK_OR_TIMEOUT";
      this.#status = {
        ...this.#status,
        lastError: error instanceof Error ? error.message : String(error),
      };
      if (classification === "permanent") {
        this.outbox.markDeadLetter(event.eventId, errorCode);
        return;
      }
      if (rpcError?.code === MESH_ERROR.AUDIT_MISSING_BLOBS) {
        for (const key of event.attachmentBlobKeys) this.outbox.markBlobUnconfirmed(key);
      }
      const operatorRequired = classification === "transient-operator";
      const waitApproval = classification === "wait-approval";
      const delay = waitApproval
        ? 30_000
        : retryDelay(event.attemptCount, operatorRequired);
      this.outbox.markRetry(
        event.eventId,
        rpcError?.code === MESH_ERROR.AUDIT_MISSING_BLOBS
          ? "PENDING_BLOBS"
          : resumeState,
        errorCode,
        Date.now() + delay,
      );
    }
  }

  async #uploadBlobs(event: StoredAuditEvent): Promise<void> {
    const attachments = eventAttachments(event);
    if (attachments.length === 0) return;
    const capability = this.mesh.status.audit;
    if (!capability || capability.version !== 1) {
      throw new Error("Hub audit capability version is incompatible");
    }
    if (
      capability.content_addressing !== "sha256" ||
      attachments.length > capability.max_attachments_per_event ||
      attachments.some((attachment) => attachment.size > capability.max_blob_bytes) ||
      attachments.reduce((total, attachment) => total + attachment.size, 0) >
        capability.max_attachments_bytes_per_event
    ) {
      throw new AuditHttpError(413, true);
    }
    const result = (await this.mesh.call("mesh.audit.prepare_blobs", {
      event_id: event.eventId,
      blobs: attachments.map((attachment) => ({
        sha256: attachment.sha256,
        size: attachment.size,
        name: attachment.filename,
      })),
    })) as PrepareBlobsResult;

    if (result.blobs.length !== attachments.length) {
      throw new Error("Hub returned an incomplete Blob preparation result");
    }
    for (const [index, prepared] of result.blobs.entries()) {
      const attachment = attachments[index];
      if (!attachment || attachment.sha256 !== prepared.sha256) {
        throw new Error("Hub returned an unmatched Blob preparation result");
      }
      const localKey = deriveBlobKey(attachment.sha256, attachment.filename);
      const blob = this.outbox.getBlob(localKey);
      if (!blob) throw new Error(`Local Blob is missing: ${localKey}`);
      if (prepared.status === "missing") {
        if (!prepared.upload) throw new Error("Missing Blob has no upload grant");
        const authorization = await this.keyManager.uploadAuthorization({
          nonce: prepared.upload.nonce,
          blobKey: prepared.blob_key,
          sha256: blob.sha256,
          size: blob.size,
        });
        // Relative upload grants are HTTP-service routes. `baseUrl` is the
        // operator-facing Hub URL; `apiHttp` may be the separate RPC/provision
        // listener in split deployments and does not serve Blob PUTs.
        const uploadUrl = new URL(prepared.upload.url, this.mesh.endpoints.baseUrl);
        const response = await fetch(uploadUrl, {
          method: "PUT",
          headers: {
            authorization,
            "content-length": String(blob.size),
            "content-type": "application/octet-stream",
          },
          body: Bun.file(blob.spoolPath),
          signal: AbortSignal.timeout(capability.upload_timeout_seconds * 1_000),
        });
        if (response.status !== 200 && response.status !== 201) {
          throw new AuditHttpError(
            response.status,
            response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429,
          );
        }
      }
      this.outbox.markBlobConfirmed(localKey, prepared.blob_key);
    }
  }

  async #append(event: StoredAuditEvent): Promise<void> {
    const raw = JSON.parse(Buffer.from(event.rawParams).toString("utf8")) as Record<
      string,
      unknown
    >;
    const attachments: AuditAttachmentRef[] = eventAttachments(event).map((attachment) => {
      const localKey = deriveBlobKey(attachment.sha256, attachment.filename);
      const blob = this.outbox.getBlob(localKey);
      if (!blob?.hubBlobKey) throw new Error(`Blob was not confirmed: ${localKey}`);
      return {
        blob_key: blob.hubBlobKey,
        sha256: attachment.sha256,
        name: attachment.filename,
        ...(attachment.media_type ? { mime: attachment.media_type } : {}),
        size: attachment.size,
      };
    });
    await this.mesh.call("mesh.audit.append", {
      schema_version: AUDIT_SCHEMA_VERSION,
      event_id: event.eventId,
      event_type:
        typeof event.correlation.audit_event_type === "string"
          ? event.correlation.audit_event_type
          : event.direction === "inbound"
            ? "channel.inbound.received"
            : "channel.outbound.requested",
      occurred_at: new Date(event.createdAt).toISOString(),
      producer_id: event.driverInstanceId ?? "lane-controller",
      direction: event.direction,
      source_kind: event.sourceKind,
      correlation: event.correlation,
      payload: raw,
      attachments,
    });
  }

  async #wait(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      this.#wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.#abort.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    this.#wake = null;
  }
}
