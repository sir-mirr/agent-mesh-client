import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { emptyConfig, type AgentMeshConfig } from "./types";
import { IDENTITY_RE } from "@agent-mesh/contracts";

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireUrl(value: unknown, label: string, protocols: string[]): void {
  if (typeof value !== "string" || !value) {
    throw new ConfigValidationError(`${label} must be a non-empty URL`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigValidationError(`${label} is not a valid URL`);
  }
  if (!protocols.includes(url.protocol)) {
    throw new ConfigValidationError(`${label} must use ${protocols.join(" or ")}`);
  }
}

function validateConfig(value: unknown): AgentMeshConfig {
  if (!isRecord(value) || value.schema_version !== 1) {
    throw new ConfigValidationError("Unsupported or missing config schema_version");
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new ConfigValidationError("Config revision must be a non-negative integer");
  }
  if (!Array.isArray(value.lanes)) {
    throw new ConfigValidationError("Config lanes must be an array");
  }
  const retiredChannelIds = value.retired_channel_ids ?? [];
  if (
    !Array.isArray(retiredChannelIds) ||
    retiredChannelIds.some((id) => typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) ||
    new Set(retiredChannelIds as string[]).size !== retiredChannelIds.length
  ) {
    throw new ConfigValidationError("retired_channel_ids must contain unique kebab-case IDs");
  }
  if (value.hub !== null) {
    if (!isRecord(value.hub)) throw new ConfigValidationError("Config hub must be an object or null");
    requireUrl(value.hub.base_url, "hub.base_url", ["http:", "https:", "ws:", "wss:"]);
    if (value.hub.rpc_ws !== undefined) {
      requireUrl(value.hub.rpc_ws, "hub.rpc_ws", ["ws:", "wss:"]);
    }
    if (value.hub.api_http !== undefined) {
      requireUrl(value.hub.api_http, "hub.api_http", ["http:", "https:"]);
    }
  }

  const laneIds = new Set<string>();
  const identities = new Set<string>();
  const channelIds = new Set<string>();
  for (const lane of value.lanes) {
    if (!isRecord(lane) || typeof lane.id !== "string" || lane.id.length === 0) {
      throw new ConfigValidationError("Every lane requires a non-empty id");
    }
    if (laneIds.has(lane.id)) throw new ConfigValidationError(`Duplicate lane: ${lane.id}`);
    laneIds.add(lane.id);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(lane.id)) {
      throw new ConfigValidationError(`Lane ID should use lowercase kebab-case: ${lane.id}`);
    }
    if (typeof lane.identity !== "string" || !IDENTITY_RE.test(lane.identity)) {
      throw new ConfigValidationError(`Lane ${lane.id} has an invalid case-sensitive identity`);
    }
    if (identities.has(lane.identity)) {
      throw new ConfigValidationError(`Identity is assigned to multiple lanes: ${lane.identity}`);
    }
    identities.add(lane.identity);
    if (typeof lane.agent_type !== "string" || lane.agent_type.length === 0) {
      throw new ConfigValidationError(`Lane ${lane.id} requires agent_type`);
    }
    if (typeof lane.enabled !== "boolean") {
      throw new ConfigValidationError(`Lane ${lane.id} enabled must be boolean`);
    }
    if (!isRecord(lane.runtime)) {
      throw new ConfigValidationError(`Lane ${lane.id} requires runtime config`);
    }
    if (
      lane.runtime.kind !== "claude" &&
      lane.runtime.kind !== "codex" &&
      lane.runtime.kind !== "antigravity"
    ) {
      throw new ConfigValidationError(`Lane ${lane.id} has unsupported runtime kind`);
    }
    if (typeof lane.runtime.workspace !== "string" || lane.runtime.workspace.length === 0) {
      throw new ConfigValidationError(`Lane ${lane.id} requires runtime workspace`);
    }
    if (lane.runtime.command !== undefined && typeof lane.runtime.command !== "string") {
      throw new ConfigValidationError(`Lane ${lane.id} runtime command must be a string`);
    }
    if (lane.runtime.model !== undefined && typeof lane.runtime.model !== "string") {
      throw new ConfigValidationError(`Lane ${lane.id} runtime model must be a string`);
    }
    if (
      lane.runtime.reply_mode !== "auto" ||
      !Number.isSafeInteger(lane.runtime.timeout_seconds) ||
      (lane.runtime.timeout_seconds as number) < 1 ||
      (lane.runtime.timeout_seconds as number) > 86_400
    ) {
      throw new ConfigValidationError(
        `Lane ${lane.id} runtime requires reply_mode=auto and timeout_seconds 1..86400`,
      );
    }
    if (!isRecord(lane.runtime.security)) {
      throw new ConfigValidationError(`Lane ${lane.id} requires runtime security policy`);
    }
    const profile = lane.runtime.security.profile;
    if (profile !== "sandboxed" && profile !== "workspace" && profile !== "unrestricted") {
      throw new ConfigValidationError(`Lane ${lane.id} has an invalid security profile`);
    }
    if (typeof lane.runtime.security.acknowledged_risk !== "boolean") {
      throw new ConfigValidationError(`Lane ${lane.id} acknowledged_risk must be boolean`);
    }
    if (profile === "unrestricted" && lane.runtime.security.acknowledged_risk !== true) {
      throw new ConfigValidationError(
        `Lane ${lane.id} unrestricted security requires acknowledged_risk=true`,
      );
    }
    if (!Array.isArray(lane.channels)) {
      throw new ConfigValidationError(`Lane ${lane.id} channels must be an array`);
    }
    for (const channel of lane.channels) {
      if (
        !isRecord(channel) ||
        typeof channel.id !== "string" ||
        channel.id.length === 0
      ) {
        throw new ConfigValidationError(`Lane ${lane.id} has an invalid channel`);
      }
      if (channelIds.has(channel.id)) {
        throw new ConfigValidationError(`driver_instance_id must be globally unique: ${channel.id}`);
      }
      if ((retiredChannelIds as string[]).includes(channel.id)) {
        throw new ConfigValidationError(`Retired driver_instance_id cannot be reused: ${channel.id}`);
      }
      if (!/^[a-z0-9][a-z0-9-]*$/.test(channel.id)) {
        throw new ConfigValidationError(`Channel ID should use lowercase kebab-case: ${channel.id}`);
      }
      if (
        typeof channel.provider !== "string" ||
        !channel.provider ||
        typeof channel.enabled !== "boolean" ||
        typeof channel.account_ref !== "string" ||
        !channel.account_ref ||
        typeof channel.secret_ref !== "string" ||
        !channel.secret_ref ||
        !isRecord(channel.options)
      ) {
        throw new ConfigValidationError(`Lane ${lane.id} channel ${channel.id} is incomplete`);
      }
      channelIds.add(channel.id);
    }
  }
  return value as unknown as AgentMeshConfig;
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class ConfigStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<AgentMeshConfig> {
    try {
      const text = await readFile(this.path, "utf8");
      return validateConfig(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyConfig();
      if (error instanceof SyntaxError) {
        throw new ConfigValidationError(`Config is not valid JSON-compatible YAML: ${error.message}`);
      }
      throw error;
    }
  }

  async save(config: AgentMeshConfig): Promise<AgentMeshConfig> {
    const validated = validateConfig(config);
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const next = { ...validated, revision: validated.revision + 1 };
    const temporaryPath = join(
      directory,
      `.${this.path.slice(this.path.lastIndexOf("/") + 1)}.${process.pid}.tmp`,
    );
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.path);
    await chmod(this.path, 0o600);
    await fsyncDirectory(directory);
    return next;
  }
}
