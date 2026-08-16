import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { ChannelConfig, LaneConfig } from "../config/types";
import { SecretStore } from "../config/secrets";
import { MAX_ATTACHMENT_BYTES } from "../constants";
import { ChannelDriverClient } from "./client";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

interface DiscordAttachment {
  id: string;
  filename: string;
  content_type?: string;
  size: number;
  url: string;
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  timestamp: string;
  author: { id: string; username?: string; bot?: boolean };
  mentions?: Array<{ id: string }>;
  attachments?: DiscordAttachment[];
}

function optionStrings(options: Record<string, unknown>, key: string): Set<string> {
  const value = options[key];
  return new Set(
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [],
  );
}

function chunks(text: string): string[] {
  if (text.length <= 2_000) return [text];
  const result: string[] = [];
  let remaining = text;
  while (remaining.length > 2_000) {
    let boundary = remaining.lastIndexOf("\n", 2_000);
    if (boundary < 1_000) boundary = 2_000;
    result.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary).replace(/^\n/, "");
  }
  if (remaining) result.push(remaining);
  return result;
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolveDelay) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolveDelay();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class DiscordDriver {
  readonly #client: ChannelDriverClient;
  readonly #database: Database;
  readonly #abort = new AbortController();
  readonly #allowedGuilds: Set<string>;
  readonly #allowedChannels: Set<string>;
  readonly #mentionOnly: boolean;
  #gateway: WebSocket | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #sequence: number | null = null;
  #botId: string | null = null;
  #loop: Promise<void> | null = null;

  private constructor(
    readonly lane: LaneConfig,
    readonly channel: ChannelConfig,
    readonly token: string,
    readonly stateDirectory: string,
    runtimeDirectory: string,
    accountRef: string,
  ) {
    this.#allowedGuilds = optionStrings(channel.options, "allowed_guild_ids");
    this.#allowedChannels = optionStrings(channel.options, "allowed_channel_ids");
    this.#mentionOnly = channel.options.mention_only === true;
    const staging = resolve(stateDirectory, "staging");
    this.#client = new ChannelDriverClient(runtimeDirectory, {
      laneId: lane.id,
      driverInstanceId: channel.id,
      provider: "discord",
      accountRef,
      stagingRoot: staging,
      capabilities: ["message.receive", "message.send"],
    });
    this.#client.onRequest((method, params) => this.#handleLaneRequest(method, params));
    this.#database = new Database(resolve(stateDirectory, "driver.sqlite3"), {
      create: true,
      strict: true,
    });
    this.#database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.#database.exec(`CREATE TABLE IF NOT EXISTS actions (
      action_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }

  static async create(options: {
    lane: LaneConfig;
    channel: ChannelConfig;
    secretStore: SecretStore;
    stateDirectory: string;
    runtimeDirectory: string;
  }): Promise<DiscordDriver> {
    await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
    const token = (await options.secretStore.get(options.channel.secret_ref)).trim();
    if (!token) throw new Error("Discord bot token is empty");
    const me = await DiscordDriver.#rest<{ id: string }>(token, "/users/@me");
    return new DiscordDriver(
      options.lane,
      options.channel,
      token,
      options.stateDirectory,
      options.runtimeDirectory,
      options.channel.account_ref || me.id,
    );
  }

  start(): void {
    if (this.#loop) return;
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    this.#gateway?.close(1000, "agent-mesh shutdown");
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#client.close();
    await this.#loop;
    this.#database.close();
  }

  async #run(): Promise<void> {
    let attempt = 0;
    while (!this.#abort.signal.aborted) {
      try {
        await this.#client.connect();
        await this.#gatewaySession();
        attempt = 0;
      } catch (error) {
        process.stderr.write(
          `[discord:${this.channel.id}] ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      if (!this.#abort.signal.aborted) {
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt++, 5));
        await abortableDelay(delay, this.#abort.signal);
      }
    }
  }

  async #gatewaySession(): Promise<void> {
    const gateway = await DiscordDriver.#rest<{ url: string }>(
      this.token,
      "/gateway/bot",
    );
    const socket = new WebSocket(`${gateway.url}?v=10&encoding=json`);
    this.#gateway = socket;
    await new Promise<void>((resolveOpen, reject) => {
      socket.addEventListener("open", () => resolveOpen(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Discord gateway failed")), {
        once: true,
      });
    });
    await new Promise<void>((resolveClosed, reject) => {
      socket.addEventListener("message", (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as GatewayPayload;
          void this.#gatewayPayload(socket, payload).catch(reject);
        } catch (error) {
          reject(error);
        }
      });
      socket.addEventListener("close", () => {
        if (this.#heartbeat) clearInterval(this.#heartbeat);
        this.#heartbeat = null;
        resolveClosed();
      });
      socket.addEventListener("error", () => reject(new Error("Discord gateway error")));
      this.#abort.signal.addEventListener(
        "abort",
        () => {
          socket.close(1000, "agent-mesh shutdown");
          resolveClosed();
        },
        { once: true },
      );
    });
  }

  async #gatewayPayload(socket: WebSocket, payload: GatewayPayload): Promise<void> {
    if (typeof payload.s === "number") this.#sequence = payload.s;
    if (payload.op === 10) {
      const hello = payload.d as { heartbeat_interval?: unknown };
      const interval =
        typeof hello.heartbeat_interval === "number" ? hello.heartbeat_interval : 45_000;
      this.#heartbeat = setInterval(() => {
        socket.send(JSON.stringify({ op: 1, d: this.#sequence }));
      }, interval);
      socket.send(
        JSON.stringify({
          op: 2,
          d: {
            token: this.token,
            intents: 1 | 512 | 4096 | 32768,
            properties: {
              os: process.platform,
              browser: "agent-mesh",
              device: "agent-mesh",
            },
          },
        }),
      );
      return;
    }
    if (payload.op === 7 || payload.op === 9) {
      socket.close(4000, "reconnect");
      return;
    }
    if (payload.op !== 0) return;
    if (payload.t === "READY") {
      const ready = payload.d as { user?: { id?: unknown } };
      if (typeof ready.user?.id === "string") this.#botId = ready.user.id;
    } else if (payload.t === "MESSAGE_CREATE") {
      await this.#handleMessage(payload.d as DiscordMessage);
    }
  }

  async #handleMessage(message: DiscordMessage): Promise<void> {
    if (!message?.id || !message.channel_id || message.author?.bot) return;
    if (this.#botId && message.author.id === this.#botId) return;
    if (this.#allowedGuilds.size && (!message.guild_id || !this.#allowedGuilds.has(message.guild_id))) {
      return;
    }
    if (this.#allowedChannels.size && !this.#allowedChannels.has(message.channel_id)) return;
    if (
      this.#mentionOnly &&
      this.#botId &&
      !message.mentions?.some((mention) => mention.id === this.#botId)
    ) {
      return;
    }
    const attachments = [];
    try {
      for (const attachment of message.attachments ?? []) {
        attachments.push(await this.#download(attachment));
      }
      await this.#client.call("channel.message.received", {
        driver_instance_id: this.channel.id,
        provider_event_id: message.id,
        provider_message_id: message.id,
        sender: {
          provider_user_id: message.author.id,
          display_name: message.author.username ?? message.author.id,
        },
        conversation: {
          account_ref: this.channel.account_ref || this.#botId || "discord-bot",
          conversation_ref: message.channel_id,
          thread_ref: null,
        },
        text: message.content || (attachments.length ? "[attachment]" : ""),
        attachments,
        provider_timestamp: message.timestamp,
      });
    } finally {
      for (const attachment of attachments) {
        await unlink(attachment.local_path).catch(() => undefined);
      }
    }
  }

  async #download(attachment: DiscordAttachment): Promise<{
    attachment_id: string;
    filename: string;
    media_type: string;
    size: number;
    sha256: string;
    local_path: string;
  }> {
    if (!Number.isSafeInteger(attachment.size) || attachment.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Discord attachment exceeds 100 MiB: ${attachment.id}`);
    }
    const url = new URL(attachment.url);
    if (url.protocol !== "https:" || !DISCORD_CDN_HOSTS.has(url.hostname)) {
      throw new Error("Discord attachment URL is outside the CDN allowlist");
    }
    const response = await fetch(url, { redirect: "error", signal: this.#abort.signal });
    if (!response.ok || !response.body) {
      throw new Error(`Discord attachment download failed: ${response.status}`);
    }
    const staging = resolve(this.stateDirectory, "staging");
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const path = resolve(staging, `${attachment.id}-${randomUUID()}.part`);
    const handle = await open(path, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > MAX_ATTACHMENT_BYTES || size > attachment.size) {
          throw new Error("Discord attachment body exceeded declared size");
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
      if (size !== attachment.size) throw new Error("Discord attachment size changed in transit");
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(path).catch(() => undefined);
      throw error;
    }
    await handle.close();
    return {
      attachment_id: attachment.id,
      filename: attachment.filename,
      media_type: attachment.content_type ?? "application/octet-stream",
      size,
      sha256: hash.digest("hex"),
      local_path: path,
    };
  }

  async #handleLaneRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method !== "channel.message.send") throw new Error(`Unsupported method: ${method}`);
    const actionId = params.action_id;
    const conversation = params.conversation;
    const text = params.text;
    if (
      typeof actionId !== "string" ||
      typeof text !== "string" ||
      !conversation ||
      typeof conversation !== "object" ||
      typeof (conversation as Record<string, unknown>).conversation_ref !== "string"
    ) {
      throw new Error("Invalid channel.message.send params");
    }
    const existing = this.#database
      .query<{ state: string; result_json: string | null }, [string]>(
        "SELECT state, result_json FROM actions WHERE action_id = ?",
      )
      .get(actionId);
    if (existing?.state === "SUCCEEDED" && existing.result_json) {
      return { ...JSON.parse(existing.result_json), duplicate: true };
    }
    const now = Date.now();
    this.#database
      .query(`INSERT INTO actions(action_id, state, created_at, updated_at)
        VALUES (?, 'PENDING', ?, ?)
        ON CONFLICT(action_id) DO UPDATE SET updated_at = excluded.updated_at`)
      .run(actionId, now, now);
    const channelId = (conversation as Record<string, unknown>).conversation_ref as string;
    const replyTo =
      typeof params.reply_to_provider_message_id === "string"
        ? params.reply_to_provider_message_id
        : null;
    let last: { id: string; timestamp?: string } | null = null;
    for (const [index, part] of chunks(text).entries()) {
      last = await DiscordDriver.#rest<{ id: string; timestamp?: string }>(
        this.token,
        `/channels/${encodeURIComponent(channelId)}/messages`,
        {
          method: "POST",
          body: {
            content: part,
            ...(index === 0 && replyTo
              ? {
                  message_reference: {
                    message_id: replyTo,
                    channel_id: channelId,
                    fail_if_not_exists: false,
                  },
                }
              : {}),
          },
        },
      );
    }
    const result = {
      provider_message_id: last?.id ?? null,
      provider_timestamp: last?.timestamp ?? new Date().toISOString(),
      duplicate: false,
    };
    this.#database
      .query(
        "UPDATE actions SET state = 'SUCCEEDED', result_json = ?, updated_at = ? WHERE action_id = ?",
      )
      .run(JSON.stringify(result), Date.now(), actionId);
    return result;
  }

  static async #rest<T>(
    token: string,
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${DISCORD_API}${path}`, {
        method: options.method ?? "GET",
        headers: {
          authorization: `Bot ${token}`,
          "content-type": "application/json",
          "user-agent": "AgentMeshClient/0.1",
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      if (response.status === 429 && attempt === 0) {
        const rate = (await response.json()) as { retry_after?: unknown };
        const milliseconds =
          typeof rate.retry_after === "number" ? Math.ceil(rate.retry_after * 1_000) : 1_000;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
        continue;
      }
      if (!response.ok) throw new Error(`Discord API ${response.status}`);
      return (await response.json()) as T;
    }
    throw new Error("Discord rate limit retry failed");
  }
}

export async function runDiscordDriver(options: {
  lane: LaneConfig;
  channel: ChannelConfig;
  secretDirectory: string;
  stateDirectory: string;
  runtimeDirectory: string;
}): Promise<void> {
  const driver = await DiscordDriver.create({
    lane: options.lane,
    channel: options.channel,
    secretStore: new SecretStore(options.secretDirectory),
    stateDirectory: options.stateDirectory,
    runtimeDirectory: options.runtimeDirectory,
  });
  driver.start();
  await new Promise<void>((resolveStop) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void driver.stop().finally(resolveStop);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
