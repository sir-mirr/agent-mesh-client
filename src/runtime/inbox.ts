import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { MeshMessageParams } from "@agent-mesh/contracts/schema";
import type { StoredAuditEvent } from "../outbox/types";
import { prefixedId } from "../util/ids";

export type RuntimeTurnState =
  | "PENDING"
  | "OBSERVED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface RuntimeTurn {
  turnId: string;
  sourceKind: "channel" | "mesh";
  sourceMessageId: string;
  content: string;
  correlation: Record<string, unknown>;
  state: RuntimeTurnState;
  response: string | null;
  conversationId: string | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeConversation {
  contextKey: string;
  conversationId: string;
  workspace: string;
  runtimeKind: string;
  model: string | null;
  successfulTurns: number;
  createdAt: number;
  lastUsedAt: number;
}

interface TurnRow {
  turn_id: string;
  source_kind: "channel" | "mesh";
  source_message_id: string;
  content: string;
  correlation_json: string;
  state: RuntimeTurnState;
  response: string | null;
  conversation_id: string | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
}

interface ConversationRow {
  context_key: string;
  conversation_id: string;
  workspace: string;
  runtime_kind: string;
  model: string | null;
  successful_turns: number;
  created_at: number;
  last_used_at: number;
}

function mapTurn(row: TurnRow): RuntimeTurn {
  return {
    turnId: row.turn_id,
    sourceKind: row.source_kind,
    sourceMessageId: row.source_message_id,
    content: row.content,
    correlation: JSON.parse(row.correlation_json) as Record<string, unknown>,
    state: row.state,
    response: row.response,
    conversationId: row.conversation_id,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConversation(row: ConversationRow): RuntimeConversation {
  return {
    contextKey: row.context_key,
    conversationId: row.conversation_id,
    workspace: row.workspace,
    runtimeKind: row.runtime_kind,
    model: row.model,
    successfulTurns: row.successful_turns,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export class RuntimeInbox {
  readonly databasePath: string;
  #database: Database | null = null;

  constructor(stateDirectory: string) {
    this.databasePath = resolve(stateDirectory, "runtime.sqlite3");
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.databasePath), { recursive: true, mode: 0o700 });
    const database = new Database(this.databasePath, { create: true, strict: true });
    database.exec("PRAGMA journal_mode=WAL;");
    database.exec("PRAGMA synchronous=FULL;");
    database.exec("PRAGMA busy_timeout=5000;");
    database.exec(`CREATE TABLE IF NOT EXISTS runtime_turns (
      turn_id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('channel','mesh')),
      source_message_id TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      correlation_json TEXT NOT NULL,
      state TEXT NOT NULL,
      response TEXT,
      conversation_id TEXT,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runtime_turns_state_idx
      ON runtime_turns(state, created_at);
    CREATE TABLE IF NOT EXISTS runtime_conversations (
      context_key TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      workspace TEXT NOT NULL,
      runtime_kind TEXT NOT NULL,
      model TEXT,
      successful_turns INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );`);
    database.exec(`UPDATE runtime_turns SET state = 'PENDING', updated_at = ${Date.now()}
      WHERE state = 'RUNNING'`);
    this.#database = database;
  }

  close(): void {
    this.#database?.close();
    this.#database = null;
  }

  #db(): Database {
    if (!this.#database) throw new Error("Runtime inbox is not initialized");
    return this.#database;
  }

  enqueueMesh(message: MeshMessageParams): RuntimeTurn {
    return this.#enqueue({
      sourceKind: "mesh",
      sourceMessageId: message.id,
      content: message.content,
      correlation: {
        source_kind: "mesh",
        from: message.from,
        sent_by: message.sent_by,
        to: message.to,
        reply_to: message.id,
        inbound_reply_to: message.reply_to,
      },
      initialState: message.reply_to === null ? "PENDING" : "OBSERVED",
    });
  }

  enqueueChannel(event: StoredAuditEvent): RuntimeTurn {
    const raw = JSON.parse(Buffer.from(event.rawParams).toString("utf8")) as {
      text?: unknown;
      provider_message_id?: unknown;
    };
    return this.#enqueue({
      sourceKind: "channel",
      sourceMessageId:
        typeof raw.provider_message_id === "string"
          ? `${event.driverInstanceId ?? "channel"}:${raw.provider_message_id}`
          : event.eventId,
      content: typeof raw.text === "string" ? raw.text : "",
      correlation: event.correlation,
      initialState: "PENDING",
    });
  }

  #enqueue(input: {
    sourceKind: "channel" | "mesh";
    sourceMessageId: string;
    content: string;
    correlation: Record<string, unknown>;
    initialState: "PENDING" | "OBSERVED";
  }): RuntimeTurn {
    const existing = this.#db()
      .query<TurnRow, [string]>("SELECT * FROM runtime_turns WHERE source_message_id = ?")
      .get(input.sourceMessageId);
    if (existing) return mapTurn(existing);
    const turnId = prefixedId("turn");
    const now = Date.now();
    this.#db()
      .query(`INSERT INTO runtime_turns (
        turn_id, source_kind, source_message_id, content, correlation_json,
        state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        turnId,
        input.sourceKind,
        input.sourceMessageId,
        input.content,
        JSON.stringify(input.correlation),
        input.initialState,
        now,
        now,
      );
    return this.get(turnId)!;
  }

  get(turnId: string): RuntimeTurn | null {
    const row = this.#db()
      .query<TurnRow, [string]>("SELECT * FROM runtime_turns WHERE turn_id = ?")
      .get(turnId);
    return row ? mapTurn(row) : null;
  }

  next(): RuntimeTurn | null {
    const row = this.#db()
      .query<TurnRow, []>(
        "SELECT * FROM runtime_turns WHERE state = 'PENDING' ORDER BY created_at LIMIT 1",
      )
      .get();
    return row ? mapTurn(row) : null;
  }

  claimNext(): RuntimeTurn | null {
    const db = this.#db();
    return db.transaction(() => {
      const row = db
        .query<TurnRow, []>(
          "SELECT * FROM runtime_turns WHERE state = 'PENDING' ORDER BY created_at LIMIT 1",
        )
        .get();
      if (!row) return null;
      db.query(
        "UPDATE runtime_turns SET state = 'RUNNING', updated_at = ? WHERE turn_id = ? AND state = 'PENDING'",
      ).run(Date.now(), row.turn_id);
      return this.get(row.turn_id);
    })();
  }

  /**
   * How many turns sit in each state.
   *
   * Lane status was read from `next()`, which answers with the first PENDING
   * turn -- so the moment a worker claimed one it returned null and the lane
   * reported idle while the runtime was mid-turn. A lane doing work has to be
   * distinguishable from one doing nothing, and the difference is here.
   */
  countsByState(): Record<string, number> {
    const rows = this.#db()
      .query<{ state: string; count: number }, []>(
        "SELECT state, COUNT(*) AS count FROM runtime_turns GROUP BY state",
      )
      .all();
    return Object.fromEntries(rows.map((row) => [row.state, row.count]));
  }

  list(limit = 50): RuntimeTurn[] {
    return this.#db()
      .query<TurnRow, [number]>("SELECT * FROM runtime_turns ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map(mapTurn);
  }

  getConversation(contextKey: string): RuntimeConversation | null {
    const row = this.#db()
      .query<ConversationRow, [string]>(
        "SELECT * FROM runtime_conversations WHERE context_key = ?",
      )
      .get(contextKey);
    return row ? mapConversation(row) : null;
  }

  saveConversation(input: {
    contextKey: string;
    conversationId: string;
    workspace: string;
    runtimeKind: string;
    model?: string | null;
  }): RuntimeConversation {
    const now = Date.now();
    this.#db()
      .query(`INSERT INTO runtime_conversations (
        context_key, conversation_id, workspace, runtime_kind, model,
        successful_turns, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(context_key) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        workspace = excluded.workspace,
        runtime_kind = excluded.runtime_kind,
        model = excluded.model,
        successful_turns = runtime_conversations.successful_turns + 1,
        last_used_at = excluded.last_used_at`)
      .run(
        input.contextKey,
        input.conversationId,
        input.workspace,
        input.runtimeKind,
        input.model ?? null,
        now,
        now,
      );
    return this.getConversation(input.contextKey)!;
  }

  resetConversation(contextKey: string): boolean {
    return this.#db()
      .query("DELETE FROM runtime_conversations WHERE context_key = ?")
      .run(contextKey).changes > 0;
  }

  listConversations(): RuntimeConversation[] {
    return this.#db()
      .query<ConversationRow, []>(
        "SELECT * FROM runtime_conversations ORDER BY last_used_at DESC",
      )
      .all()
      .map(mapConversation);
  }

  markRunning(turnId: string): void {
    this.#setState(turnId, "RUNNING", null, null, null);
  }

  complete(turnId: string, response: string, conversationId?: string): void {
    this.#setState(turnId, "COMPLETED", response, conversationId ?? null, null);
  }

  fail(turnId: string, errorCode: string): void {
    this.#setState(turnId, "FAILED", null, null, errorCode);
  }

  #setState(
    turnId: string,
    state: RuntimeTurnState,
    response: string | null,
    conversationId: string | null,
    errorCode: string | null,
  ): void {
    this.#db()
      .query(`UPDATE runtime_turns SET state = ?, response = ?, conversation_id = ?,
        error_code = ?, updated_at = ? WHERE turn_id = ?`)
      .run(state, response, conversationId, errorCode, Date.now(), turnId);
  }
}
