export type AuditDirection = "inbound" | "outbound";
export type AuditSourceKind = "channel" | "mesh";
export type AuditEventState =
  | "PENDING_BLOBS"
  | "PENDING_APPEND"
  | "RETRY_WAIT"
  | "ACKED"
  | "DEAD_LETTER";

export interface StagedAttachment {
  attachment_id: string;
  filename: string;
  media_type: string;
  size: number;
  sha256: string;
  local_path: string;
}

export interface AuditEventInput {
  direction: AuditDirection;
  sourceKind: AuditSourceKind;
  driverInstanceId?: string;
  rawParams: unknown;
  attachments: StagedAttachment[];
  stagingRoot?: string;
  correlation: Record<string, unknown>;
  dedupKey?: string;
}

export interface StoredAuditEvent {
  eventId: string;
  inboundId: string | null;
  laneId: string;
  direction: AuditDirection;
  sourceKind: AuditSourceKind;
  driverInstanceId: string | null;
  schemaVersion: number;
  rawParams: Uint8Array;
  rawParamsSha256: string;
  attachmentBlobKeys: string[];
  correlation: Record<string, unknown>;
  state: AuditEventState;
  resumeState: "PENDING_BLOBS" | "PENDING_APPEND";
  attemptCount: number;
  nextAttemptAt: number;
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
  ackedAt: number | null;
}

export interface StoredBlob {
  blobKey: string;
  sha256: string;
  normalizedExtension: string;
  size: number;
  spoolPath: string;
  localRefCount: number;
  hubConfirmed: boolean;
  hubBlobKey: string | null;
}

export interface OutboxSummary {
  pending: number;
  retry: number;
  deadLetter: number;
  acked: number;
  blobBytes: number;
  usageRatio: number;
  warning: boolean;
  failClosed: boolean;
}
