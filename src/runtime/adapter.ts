import type { RuntimeConfig } from "../config/types";
import type { RuntimeTurn } from "./inbox";

export interface RuntimeInvocation {
  laneId: string;
  turn: RuntimeTurn;
  contextKey: string;
  conversationId: string | null;
  signal: AbortSignal;
}

export interface RuntimeResult {
  response: string;
  conversationId: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeAdapter {
  readonly kind: RuntimeConfig["kind"];
  run(invocation: RuntimeInvocation): Promise<RuntimeResult>;
  stop(): Promise<void>;
}

export class RuntimeAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeAdapterError";
  }
}

export function runtimeContextKey(
  laneId: string,
  workspace: string,
  turn: RuntimeTurn,
): string {
  const correlation = turn.correlation;
  const parts =
    turn.sourceKind === "mesh"
      ? ["mesh", correlation.from]
      : [
          "channel",
          correlation.provider,
          correlation.driver_instance_id,
          correlation.account_ref,
          correlation.conversation_ref,
          correlation.thread_ref,
        ];
  return JSON.stringify([
    laneId,
    workspace,
    ...parts.map((value) => (typeof value === "string" ? value : "")),
  ]);
}
