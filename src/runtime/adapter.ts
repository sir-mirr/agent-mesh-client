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
  /**
   * Bring up whatever the lane's session lives in, before any turn arrives.
   *
   * Only runtimes that hold a session implement this. Starting it lazily made
   * the session conditional on traffic: a lane could be enabled, connected and
   * approved, and still have nothing to attach to -- so the answer to "open my
   * agent" was "send it a message first", which is backwards. Failure here is
   * reported and does not stop the lane; the turn path starts it again.
   */
  warmUp?(): Promise<void>;
  /**
   * The conversation this runtime is holding open, when it holds one.
   *
   * Only meaningful for a runtime whose session outlives a turn. Reported so
   * an operator can attach to it before any message has arrived.
   */
  sessionThreadId?(): string | null;
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
