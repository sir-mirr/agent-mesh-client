export type RuntimeKind = "claude" | "codex" | "antigravity";
export type ChannelProvider = "discord" | string;

export interface HubConfig {
  base_url: string;
  rpc_ws?: string;
  api_http?: string;
}

export interface RuntimeSecurityConfig {
  profile: "sandboxed" | "workspace" | "unrestricted";
  acknowledged_risk: boolean;
}

export interface RuntimeConfig {
  kind: RuntimeKind;
  command?: string;
  workspace: string;
  model?: string;
  reply_mode: "auto";
  timeout_seconds: number;
  security: RuntimeSecurityConfig;
}

export interface ChannelConfig {
  id: string;
  provider: ChannelProvider;
  enabled: boolean;
  account_ref: string;
  secret_ref: string;
  options: Record<string, unknown>;
}

export interface LaneConfig {
  id: string;
  identity: string;
  agent_type: string;
  enabled: boolean;
  runtime: RuntimeConfig;
  channels: ChannelConfig[];
}

export interface AgentMeshConfig {
  schema_version: 1;
  revision: number;
  hub: HubConfig | null;
  lanes: LaneConfig[];
  /** Permanent tombstones: provider idempotency state makes these unsafe to reuse. */
  retired_channel_ids?: string[];
}

export function emptyConfig(): AgentMeshConfig {
  return { schema_version: 1, revision: 0, hub: null, lanes: [], retired_channel_ids: [] };
}
