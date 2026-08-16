import type { RuntimeConfig } from "../config/types";
import type { RuntimeAdapter } from "./adapter";
import { RuntimeAdapterError, runtimeContextKey } from "./adapter";
import type { RuntimeInbox, RuntimeTurn } from "./inbox";

export interface RuntimeWorkerOptions {
  laneId: string;
  config: RuntimeConfig;
  inbox: RuntimeInbox;
  adapter: RuntimeAdapter;
  reply: (turn: RuntimeTurn, response: string) => Promise<void>;
  onDiagnostic?: (message: string, error?: unknown) => void;
}

export class RuntimeWorker {
  readonly #abort = new AbortController();
  #loop: Promise<void> | null = null;

  constructor(readonly options: RuntimeWorkerOptions) {}

  start(): void {
    if (this.#loop) return;
    void this.options.adapter.warmUp?.().catch((error: unknown) =>
      this.options.onDiagnostic?.(
        `Runtime session did not start for lane ${this.options.laneId}`,
        error,
      ),
    );
    this.#loop = this.#runLoop();
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    await this.#loop;
    this.#loop = null;
    await this.options.adapter.stop();
  }

  async #runLoop(): Promise<void> {
    while (!this.#abort.signal.aborted) {
      const turn = this.options.inbox.next();
      if (!turn) {
        await this.#sleep(250);
        continue;
      }
      await this.#runTurn(turn);
    }
  }

  async #runTurn(turn: RuntimeTurn): Promise<void> {
    this.options.inbox.markRunning(turn.turnId);
    const contextKey = runtimeContextKey(
      this.options.laneId,
      this.options.config.workspace,
      turn,
    );
    const stored = this.options.inbox.getConversation(contextKey);
    const conversationId =
      stored &&
      stored.workspace === this.options.config.workspace &&
      stored.runtimeKind === this.options.config.kind &&
      stored.model === (this.options.config.model ?? null)
        ? stored.conversationId
        : null;
    const deadline = new AbortController();
    const onStop = () => deadline.abort(this.#abort.signal.reason);
    this.#abort.signal.addEventListener("abort", onStop, { once: true });
    const timer = setTimeout(
      () => deadline.abort(new RuntimeAdapterError("TURN_TIMEOUT", "Runtime turn timed out")),
      this.options.config.timeout_seconds * 1_000,
    );
    try {
      const result = await this.options.adapter.run({
        laneId: this.options.laneId,
        turn,
        contextKey,
        conversationId,
        signal: deadline.signal,
      });
      if (!result.response.trim()) {
        throw new RuntimeAdapterError("EMPTY_RESPONSE", "Runtime returned an empty response");
      }
      await this.options.reply(turn, result.response);
      this.options.inbox.saveConversation({
        contextKey,
        conversationId: result.conversationId,
        workspace: this.options.config.workspace,
        runtimeKind: this.options.config.kind,
        model: this.options.config.model ?? null,
      });
      this.options.inbox.complete(turn.turnId, result.response, result.conversationId);
    } catch (error) {
      const code =
        deadline.signal.aborted && !this.#abort.signal.aborted
          ? "TURN_TIMEOUT"
          : error instanceof RuntimeAdapterError
            ? error.code
            : "RUNTIME_FAILED";
      this.options.inbox.fail(turn.turnId, code);
      this.options.onDiagnostic?.(
        `Runtime turn ${turn.turnId} failed (${code})`,
        error,
      );
      if (!this.#abort.signal.aborted) {
        await this.options
          .reply(turn, `런타임 처리에 실패했습니다. 오류 코드: ${code}`)
          .catch((replyError) =>
            this.options.onDiagnostic?.(
              `Runtime error reply failed for ${turn.turnId}`,
              replyError,
            ),
          );
      }
    } finally {
      clearTimeout(timer);
      this.#abort.signal.removeEventListener("abort", onStop);
    }
  }

  async #sleep(milliseconds: number): Promise<void> {
    if (this.#abort.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.#abort.signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      this.#abort.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
