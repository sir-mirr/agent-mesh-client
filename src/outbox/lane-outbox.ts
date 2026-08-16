import { createHash } from "node:crypto";
import { mkdir, open, statfs } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { prefixedId } from "../util/ids";
import { BlobSpool, validateAttachmentSet } from "./blob-spool";
import type {
  AuditEventInput,
  AuditEventState,
  OutboxSummary,
  StoredAuditEvent,
  StoredBlob,
} from "./types";

const DEFAULT_QUOTA_BYTES = 20 * 1024 * 1024 * 1024;
const WARNING_RATIO = 0.8;
const FAIL_CLOSED_RATIO = 0.95;
const MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024;

interface EventRow {
  event_id: string;
  inbound_id: string | null;
  lane_id: string;
  direction: "inbound" | "outbound";
  source_kind: "channel" | "mesh";
  driver_instance_id: string | null;
  schema_version: number;
  raw_params: Uint8Array;
  raw_params_sha256: string;
  attachment_blob_keys: string;
  correlation: string;
  state: AuditEventState;
  resume_state: "PENDING_BLOBS" | "PENDING_APPEND";
  attempt_count: number;
  next_attempt_at: number;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
  acked_at: number | null;
}

interface BlobRow {
  blob_key: string;
  sha256: string;
  normalized_extension: string;
  size: number;
  spool_path: string;
  local_ref_count: number;
  hub_confirmed: number;
  hub_blob_key: string | null;
}

export interface PendingDeliveryAction {
  actionId: string;
  driverInstanceId: string;
  request: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

function mapEvent(row: EventRow): StoredAuditEvent {
  return {
    eventId: row.event_id,
    inboundId: row.inbound_id,
    laneId: row.lane_id,
    direction: row.direction,
    sourceKind: row.source_kind,
    driverInstanceId: row.driver_instance_id,
    schemaVersion: row.schema_version,
    rawParams: row.raw_params,
    rawParamsSha256: row.raw_params_sha256,
    attachmentBlobKeys: JSON.parse(row.attachment_blob_keys) as string[],
    correlation: JSON.parse(row.correlation) as Record<string, unknown>,
    state: row.state,
    resumeState: row.resume_state,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ackedAt: row.acked_at,
  };
}

function mapBlob(row: BlobRow): StoredBlob {
  return {
    blobKey: row.blob_key,
    sha256: row.sha256,
    normalizedExtension: row.normalized_extension,
    size: row.size,
    spoolPath: row.spool_path,
    localRefCount: row.local_ref_count,
    hubConfirmed: row.hub_confirmed === 1,
    hubBlobKey: row.hub_blob_key,
  };
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class OutboxCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboxCapacityError";
  }
}

export class LaneOutbox {
  readonly databasePath: string;
  readonly spool: BlobSpool;
  readonly #quotaBytes: number;
  #database: Database | null = null;

  constructor(
    readonly laneId: string,
    readonly stateDirectory: string,
    options: { quotaBytes?: number } = {},
  ) {
    this.databasePath = resolve(stateDirectory, "outbox.sqlite3");
    this.spool = new BlobSpool(resolve(stateDirectory, "spool"));
    this.#quotaBytes = options.quotaBytes ?? DEFAULT_QUOTA_BYTES;
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.databasePath), { recursive: true, mode: 0o700 });
    await this.spool.initialize();
    const database = new Database(this.databasePath, { create: true, strict: true });
    database.exec("PRAGMA journal_mode=WAL;");
    database.exec("PRAGMA synchronous=FULL;");
    database.exec("PRAGMA foreign_keys=ON;");
    database.exec("PRAGMA busy_timeout=5000;");
    database.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        inbound_id TEXT,
        lane_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
        source_kind TEXT NOT NULL CHECK(source_kind IN ('channel','mesh')),
        driver_instance_id TEXT,
        schema_version INTEGER NOT NULL,
        raw_params BLOB NOT NULL,
        raw_params_sha256 TEXT NOT NULL,
        attachment_blob_keys TEXT NOT NULL,
        correlation TEXT NOT NULL,
        dedup_key TEXT UNIQUE,
        state TEXT NOT NULL,
        resume_state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        acked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS events_due_idx ON events(state, next_attempt_at);
      CREATE TABLE IF NOT EXISTS blobs (
        blob_key TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        normalized_extension TEXT NOT NULL,
        size INTEGER NOT NULL,
        spool_path TEXT NOT NULL,
        local_ref_count INTEGER NOT NULL,
        hub_confirmed INTEGER NOT NULL DEFAULT 0,
        hub_blob_key TEXT,
        created_at INTEGER NOT NULL,
        last_verified_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event_blobs (
        event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE RESTRICT,
        blob_key TEXT NOT NULL REFERENCES blobs(blob_key) ON DELETE RESTRICT,
        PRIMARY KEY(event_id, blob_key)
      );
      CREATE TABLE IF NOT EXISTS delivery_outcomes (
        action_id TEXT PRIMARY KEY,
        driver_instance_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        result_json TEXT,
        state TEXT NOT NULL CHECK(state IN ('PENDING','SUCCEEDED','FAILED')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const blobColumns = database
      .query<{ name: string }, []>("PRAGMA table_info(blobs)")
      .all()
      .map((column) => column.name);
    if (!blobColumns.includes("hub_blob_key")) {
      database.exec("ALTER TABLE blobs ADD COLUMN hub_blob_key TEXT");
    }
    this.#database = database;
    await syncDirectory(dirname(this.databasePath));
  }

  close(): void {
    this.#database?.close();
    this.#database = null;
  }

  #db(): Database {
    if (!this.#database) throw new Error("Lane outbox is not initialized");
    return this.#database;
  }

  async summary(): Promise<OutboxSummary> {
    const db = this.#db();
    const counts = db
      .query<{
        pending: number;
        retry: number;
        dead_letter: number;
        acked: number;
      }, []>(`SELECT
        SUM(CASE WHEN state IN ('PENDING_BLOBS','PENDING_APPEND') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN state = 'RETRY_WAIT' THEN 1 ELSE 0 END) AS retry,
        SUM(CASE WHEN state = 'DEAD_LETTER' THEN 1 ELSE 0 END) AS dead_letter,
        SUM(CASE WHEN state = 'ACKED' THEN 1 ELSE 0 END) AS acked
      FROM events`)
      .get() ?? { pending: 0, retry: 0, dead_letter: 0, acked: 0 };
    const blobBytes =
      db.query<{ total: number }, []>("SELECT COALESCE(SUM(size), 0) AS total FROM blobs").get()
        ?.total ?? 0;
    const usageRatio = blobBytes / this.#quotaBytes;
    const filesystem = await statfs(this.stateDirectory);
    const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    return {
      pending: counts.pending ?? 0,
      retry: counts.retry ?? 0,
      deadLetter: counts.dead_letter ?? 0,
      acked: counts.acked ?? 0,
      blobBytes,
      usageRatio,
      warning: usageRatio >= WARNING_RATIO,
      failClosed: usageRatio >= FAIL_CLOSED_RATIO || freeBytes < MIN_FREE_BYTES,
    };
  }

  async record(input: AuditEventInput): Promise<StoredAuditEvent> {
    const db = this.#db();
    const capacity = await this.summary();
    if (capacity.failClosed) {
      throw new OutboxCapacityError("Lane outbox capacity safety threshold reached");
    }
    validateAttachmentSet(input.attachments);
    if (input.attachments.length > 0 && !input.stagingRoot) {
      throw new Error("stagingRoot is required when attachments are present");
    }
    if (input.dedupKey) {
      const duplicate = db
        .query<EventRow, [string]>("SELECT * FROM events WHERE dedup_key = ?")
        .get(input.dedupKey);
      if (duplicate) return mapEvent(duplicate);
    }

    const blobs: StoredBlob[] = [];
    for (const attachment of input.attachments) {
      blobs.push(await this.spool.ingest(attachment, input.stagingRoot!));
    }
    const rawParams = Buffer.from(JSON.stringify(input.rawParams), "utf8");
    const rawParamsSha256 = createHash("sha256").update(rawParams).digest("hex");
    const eventId = prefixedId("aud");
    const inboundId = input.direction === "inbound" ? prefixedId("in") : null;
    const now = Date.now();
    const keys = [...new Set(blobs.map((blob) => blob.blobKey))];

    const commit = db.transaction(() => {
      for (const blob of blobs) {
        db.query(`INSERT INTO blobs (
          blob_key, sha256, normalized_extension, size, spool_path,
          local_ref_count, hub_confirmed, created_at, last_verified_at
        ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
        ON CONFLICT(blob_key) DO UPDATE SET last_verified_at = excluded.last_verified_at`)
          .run(
            blob.blobKey,
            blob.sha256,
            blob.normalizedExtension,
            blob.size,
            blob.spoolPath,
            now,
            now,
          );
      }
      db.query(`INSERT INTO events (
        event_id, inbound_id, lane_id, direction, source_kind,
        driver_instance_id, schema_version, raw_params, raw_params_sha256,
        attachment_blob_keys, correlation, dedup_key, state, resume_state,
        attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'PENDING_BLOBS',
        'PENDING_BLOBS', 0, 0, ?, ?)`)
        .run(
          eventId,
          inboundId,
          this.laneId,
          input.direction,
          input.sourceKind,
          input.driverInstanceId ?? null,
          rawParams,
          rawParamsSha256,
          JSON.stringify(keys),
          JSON.stringify(input.correlation),
          input.dedupKey ?? null,
          now,
          now,
        );
      for (const key of keys) {
        db.query("INSERT INTO event_blobs(event_id, blob_key) VALUES (?, ?)").run(
          eventId,
          key,
        );
        db.query("UPDATE blobs SET local_ref_count = local_ref_count + 1 WHERE blob_key = ?").run(
          key,
        );
      }
    });
    commit();
    const stored = db.query<EventRow, [string]>("SELECT * FROM events WHERE event_id = ?").get(eventId);
    if (!stored) throw new Error("Committed outbox event could not be read back");
    return mapEvent(stored);
  }

  listDue(now = Date.now(), limit = 20): StoredAuditEvent[] {
    return this.#db()
      .query<EventRow, [number, number]>(`SELECT * FROM events
        WHERE state IN ('PENDING_BLOBS','PENDING_APPEND')
           OR (state = 'RETRY_WAIT' AND next_attempt_at <= ?)
        ORDER BY created_at ASC LIMIT ?`)
      .all(now, limit)
      .map(mapEvent);
  }

  findByDedupKey(dedupKey: string): StoredAuditEvent | null {
    const row = this.#db()
      .query<EventRow, [string]>("SELECT * FROM events WHERE dedup_key = ?")
      .get(dedupKey);
    return row ? mapEvent(row) : null;
  }

  getBlob(blobKey: string): StoredBlob | null {
    const row = this.#db()
      .query<BlobRow, [string]>("SELECT * FROM blobs WHERE blob_key = ?")
      .get(blobKey);
    return row ? mapBlob(row) : null;
  }

  markBlobConfirmed(blobKey: string, hubBlobKey = blobKey): void {
    this.#db()
      .query(`UPDATE blobs SET hub_confirmed = 1, hub_blob_key = ?,
        last_verified_at = ? WHERE blob_key = ?`)
      .run(hubBlobKey, Date.now(), blobKey);
  }

  markBlobUnconfirmed(blobKey: string): void {
    this.#db()
      .query("UPDATE blobs SET hub_confirmed = 0, hub_blob_key = NULL WHERE blob_key = ?")
      .run(blobKey);
  }

  blobsConfirmed(event: StoredAuditEvent): boolean {
    for (const key of event.attachmentBlobKeys) {
      if (!this.getBlob(key)?.hubConfirmed) return false;
    }
    return true;
  }

  markPendingAppend(eventId: string): void {
    this.#transition(eventId, "PENDING_APPEND", "PENDING_APPEND", 0, null);
  }

  markAcked(eventId: string): void {
    const now = Date.now();
    this.#db()
      .query(`UPDATE events SET state = 'ACKED', acked_at = ?, updated_at = ?,
        last_error_code = NULL WHERE event_id = ?`)
      .run(now, now, eventId);
  }

  markRetry(
    eventId: string,
    resumeState: "PENDING_BLOBS" | "PENDING_APPEND",
    errorCode: string,
    nextAttemptAt: number,
  ): void {
    this.#transition(eventId, "RETRY_WAIT", resumeState, nextAttemptAt, errorCode, true);
  }

  markDeadLetter(eventId: string, errorCode: string): void {
    this.#transition(eventId, "DEAD_LETTER", "PENDING_APPEND", 0, errorCode, true);
  }

  listDeadLetters(limit = 100): StoredAuditEvent[] {
    return this.#db()
      .query<EventRow, [number]>(
        `SELECT * FROM events WHERE state = 'DEAD_LETTER'
         ORDER BY updated_at ASC LIMIT ?`,
      )
      .all(limit)
      .map(mapEvent);
  }

  /**
   * Return dead-lettered events to the queue.
   *
   * Dead-lettering quarantines rather than deletes, but quarantine is only
   * half of what SPEC § 8.9.3 asks for if nothing can let the event out again.
   * A version skew is the case that needs this: a code the running client has
   * never seen is classified by the default its call site chose, and when that
   * default guesses wrong the events it stopped are correct and appendable.
   *
   * `attemptCount` is left alone. It is the record of how hard this event has
   * already been tried, and resetting it would hide a payload that fails on
   * every replay. `lastErrorCode` is kept for the same reason: an operator
   * watching the queue drain needs to see what stopped each row.
   */
  replayDeadLetters(eventIds?: readonly string[]): {
    replayed: string[];
    skipped: string[];
  } {
    const db = this.#db();
    const candidates =
      eventIds === undefined
        ? this.listDeadLetters(Number.MAX_SAFE_INTEGER).map((event) => event.eventId)
        : eventIds;
    const replayed: string[] = [];
    const skipped: string[] = [];
    const now = Date.now();
    for (const eventId of candidates) {
      const row = db
        .query<EventRow, [string]>("SELECT * FROM events WHERE event_id = ?")
        .get(eventId);
      // Anything not dead-lettered is either already moving or already acked.
      // Dragging it backwards would re-send an event the Hub has accepted.
      if (!row || row.state !== "DEAD_LETTER") {
        skipped.push(eventId);
        continue;
      }
      // Resume before the blob phase whenever an attachment is unconfirmed:
      // `mesh.audit.prepare_blobs` reports the ones the Hub already holds, so
      // re-running it costs a round-trip, while skipping it on an unuploaded
      // blob fails the append with AUDIT_MISSING_BLOBS.
      const resumeState = this.blobsConfirmed(mapEvent(row)) ? "PENDING_APPEND" : "PENDING_BLOBS";
      db.query(
        `UPDATE events SET state = ?, resume_state = ?, next_attempt_at = 0,
         updated_at = ? WHERE event_id = ? AND state = 'DEAD_LETTER'`,
      ).run(resumeState, resumeState, now, eventId);
      replayed.push(eventId);
    }
    return { replayed, skipped };
  }

  #transition(
    eventId: string,
    state: AuditEventState,
    resumeState: "PENDING_BLOBS" | "PENDING_APPEND",
    nextAttemptAt: number,
    errorCode: string | null,
    incrementAttempt = false,
  ): void {
    this.#db()
      .query(`UPDATE events SET state = ?, resume_state = ?, next_attempt_at = ?,
        last_error_code = ?, updated_at = ?,
        attempt_count = attempt_count + ? WHERE event_id = ?`)
      .run(
        state,
        resumeState,
        nextAttemptAt,
        errorCode,
        Date.now(),
        incrementAttempt ? 1 : 0,
        eventId,
      );
  }

  reserveAction(
    actionId: string,
    driverInstanceId: string,
    request: unknown,
  ): { duplicate: boolean; result: unknown | null } {
    const db = this.#db();
    const existing = db
      .query<{ state: string; result_json: string | null }, [string]>(
        "SELECT state, result_json FROM delivery_outcomes WHERE action_id = ?",
      )
      .get(actionId);
    if (existing) {
      return {
        duplicate: true,
        result: existing.result_json ? JSON.parse(existing.result_json) : null,
      };
    }
    const now = Date.now();
    db.query(`INSERT INTO delivery_outcomes (
      action_id, driver_instance_id, request_json, state, created_at, updated_at
    ) VALUES (?, ?, ?, 'PENDING', ?, ?)`)
      .run(actionId, driverInstanceId, JSON.stringify(request), now, now);
    return { duplicate: false, result: null };
  }

  completeAction(actionId: string, result: unknown): void {
    this.#db()
      .query(`UPDATE delivery_outcomes SET state = 'SUCCEEDED', result_json = ?,
        updated_at = ? WHERE action_id = ?`)
      .run(JSON.stringify(result), Date.now(), actionId);
  }

  listPendingActions(olderThan = Date.now(), limit = 20): PendingDeliveryAction[] {
    return this.#db()
      .query<{
        action_id: string;
        driver_instance_id: string;
        request_json: string;
        created_at: number;
        updated_at: number;
      }, [number, number]>(`SELECT action_id, driver_instance_id, request_json,
        created_at, updated_at FROM delivery_outcomes
        WHERE state = 'PENDING' AND updated_at <= ?
        ORDER BY created_at LIMIT ?`)
      .all(olderThan, limit)
      .map((row) => ({
        actionId: row.action_id,
        driverInstanceId: row.driver_instance_id,
        request: JSON.parse(row.request_json) as Record<string, unknown>,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }
}
