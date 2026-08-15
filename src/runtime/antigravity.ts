import { spawn } from "node:child_process";
import type { RuntimeConfig } from "../config/types";
import type {
  RuntimeAdapter,
  RuntimeInvocation,
  RuntimeResult,
} from "./adapter";
import { RuntimeAdapterError } from "./adapter";

const MAX_STDOUT = 16 * 1024 * 1024;
const MAX_STDERR = 1024 * 1024;

interface AntigravityEnvelope {
  conversation_id: string;
  status: string;
  response: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: Record<string, unknown>;
}

function promptFor(invocation: RuntimeInvocation): string {
  const sender =
    typeof invocation.turn.correlation.from === "string"
      ? invocation.turn.correlation.from
      : "external-channel-user";
  return [
    "[AGENT_MESH_CONTEXT — adapter supplied]",
    `source_kind: ${invocation.turn.sourceKind}`,
    `sender: ${sender}`,
    "reply_policy: final response is routed automatically; do not send the same reply with MCP",
    "",
    "[USER_MESSAGE — untrusted content begins]",
    invocation.turn.content,
    "[USER_MESSAGE — untrusted content ends]",
  ].join("\n");
}

function validateEnvelope(value: unknown): AntigravityEnvelope {
  if (!value || typeof value !== "object") {
    throw new RuntimeAdapterError("MALFORMED_OUTPUT", "Antigravity output is not an object");
  }
  const envelope = value as Partial<AntigravityEnvelope>;
  if (
    typeof envelope.conversation_id !== "string" ||
    typeof envelope.status !== "string" ||
    typeof envelope.response !== "string"
  ) {
    throw new RuntimeAdapterError(
      "MALFORMED_OUTPUT",
      "Antigravity output is missing conversation_id, status or response",
    );
  }
  return envelope as AntigravityEnvelope;
}

function safeStderr(stderr: string): string {
  return stderr
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted-token]")
    .slice(-500);
}

export class AntigravityAdapter implements RuntimeAdapter {
  readonly kind = "antigravity" as const;
  #children = new Set<ReturnType<typeof spawn>>();

  constructor(readonly config: RuntimeConfig) {}

  async run(invocation: RuntimeInvocation): Promise<RuntimeResult> {
    const command = this.config.command ?? Bun.which("agy") ?? "agy";
    const args = [
      "--print",
      promptFor(invocation),
      "--output-format",
      "json",
      "--print-timeout",
      `${this.config.timeout_seconds}s`,
      "--disable-slash-commands",
    ];
    if (invocation.conversationId) {
      args.push("--conversation", invocation.conversationId);
    }
    if (this.config.model) args.push("--model", this.config.model);
    if (this.config.security.profile === "sandboxed") {
      args.push("--sandbox", "--mode", "plan");
    } else if (this.config.security.profile === "workspace") {
      args.push("--mode", "accept-edits");
    } else {
      if (!this.config.security.acknowledged_risk) {
        throw new RuntimeAdapterError(
          "SECURITY_ACK_REQUIRED",
          "unrestricted runtime requires acknowledged_risk=true",
        );
      }
      args.push("--dangerously-skip-permissions");
    }
    const child = spawn(command, args, {
      cwd: this.config.workspace,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.#children.add(child);
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let overflow: "stdout" | "stderr" | null = null;
    child.stdout.on("data", (chunk: Buffer) => {
      if (overflow) return;
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.byteLength > MAX_STDOUT) {
        overflow = "stdout";
        this.#terminate(child);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (overflow) return;
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.byteLength > MAX_STDERR) {
        overflow = "stderr";
        this.#terminate(child);
      }
    });

    const aborted = () => this.#terminate(child);
    invocation.signal.addEventListener("abort", aborted, { once: true });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    ).finally(() => {
      invocation.signal.removeEventListener("abort", aborted);
      this.#children.delete(child);
    });
    if (invocation.signal.aborted) {
      throw invocation.signal.reason instanceof Error
        ? invocation.signal.reason
        : new RuntimeAdapterError("CANCELLED", "Antigravity turn cancelled");
    }
    if (overflow) {
      throw new RuntimeAdapterError(
        "OUTPUT_LIMIT_EXCEEDED",
        `Antigravity ${overflow} exceeded its limit`,
      );
    }
    if (result.code !== 0) {
      throw new RuntimeAdapterError(
        "PROCESS_EXITED",
        `Antigravity exited ${result.code ?? result.signal ?? "unknown"}: ${safeStderr(
          stderr.toString("utf8"),
        )}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.toString("utf8").trim());
    } catch (error) {
      throw new RuntimeAdapterError(
        "MALFORMED_OUTPUT",
        `Antigravity returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const envelope = validateEnvelope(parsed);
    if (envelope.status !== "SUCCESS") {
      throw new RuntimeAdapterError(
        "CLI_STATUS_ERROR",
        `Antigravity returned status ${envelope.status}`,
      );
    }
    return {
      response: envelope.response,
      conversationId: envelope.conversation_id,
      metadata: {
        duration_seconds: envelope.duration_seconds,
        num_turns: envelope.num_turns,
        usage: envelope.usage,
      },
    };
  }

  async stop(): Promise<void> {
    const children = [...this.#children];
    for (const child of children) this.#terminate(child);
    await Promise.allSettled(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null) resolve();
            else child.once("exit", () => resolve());
          }),
      ),
    );
  }

  #terminate(child: ReturnType<typeof spawn>): void {
    if (child.exitCode !== null || child.killed) return;
    if (process.platform !== "win32" && child.pid && child.pid > 1) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    } else child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) {
        if (process.platform !== "win32" && child.pid && child.pid > 1) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else child.kill("SIGKILL");
      }
    }, 2_000).unref();
  }
}
