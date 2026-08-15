import { createInterface } from "node:readline";
import { requestControl } from "../daemon/host-daemon";
import type { RuntimeTurn } from "./inbox";

interface McpRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

export interface ClaudeChannelMcpOptions {
  laneId: string;
  runtimeDirectory: string;
}

const TOOLS = [
  {
    name: "reply",
    description:
      "Reply to the current Agent Mesh channel turn. Use turn_id from the inbound channel metadata. The daemon routes it to the immutable source.",
    inputSchema: {
      type: "object",
      properties: {
        turn_id: { type: "string", description: "Inbound Agent Mesh turn_id." },
        chat_id: { type: "string", description: "Inbound chat_id for human readability." },
        text: { type: "string", description: "Final response text." },
        reply_to: { type: "string", description: "Inbound message_id, if threading is desired." },
      },
      required: ["turn_id", "text"],
    },
  },
  {
    name: "send_message",
    description: "Send a new message to another Agent Mesh identity.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        text: { type: "string" },
        reply_to: { type: "string" },
      },
      required: ["to", "text"],
    },
  },
  {
    name: "list_agents",
    description: "List registered Agent Mesh identities and presence.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "fetch_messages",
    description: "Show the local durable Agent Mesh inbox for this lane.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", minimum: 1, maximum: 200 } },
    },
  },
] as const;

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function content(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

export async function runClaudeChannelMcp(
  options: ClaudeChannelMcpOptions,
): Promise<void> {
  let initialized = false;
  let stopped = false;
  const activeTurns = new Map<string, RuntimeTurn>();

  const poll = async () => {
    if (!initialized || stopped) return;
    try {
      const turn = (await requestControl(options.runtimeDirectory, "runtime.claim", {
        lane_id: options.laneId,
      })) as RuntimeTurn | null;
      if (!turn) return;
      activeTurns.set(turn.turnId, turn);
      const chatId =
        typeof turn.correlation.from === "string"
          ? turn.correlation.from
          : typeof turn.correlation.conversation_ref === "string"
            ? turn.correlation.conversation_ref
            : "channel";
      write({
        jsonrpc: "2.0",
        method: "notifications/claude/channel",
        params: {
          content: turn.content || "(empty message)",
          meta: {
            source: "agent-mesh",
            turn_id: turn.turnId,
            chat_id: chatId,
            message_id: turn.sourceMessageId,
            user: chatId,
            user_id: chatId,
            ...(typeof turn.correlation.to === "string"
              ? { to: turn.correlation.to }
              : {}),
            ...(typeof turn.correlation.reply_to === "string"
              ? { reply_to: turn.correlation.reply_to }
              : {}),
          },
        },
      });
    } catch (error) {
      process.stderr.write(
        `[agent-mesh claude] inbox poll failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  };
  const timer = setInterval(() => void poll(), 500);
  timer.unref();

  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    void (async () => {
      let request: McpRequest;
      try {
        request = JSON.parse(line) as McpRequest;
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      if (request.method === "notifications/initialized") {
        initialized = true;
        void poll();
        return;
      }
      if (request.id === undefined) return;
      try {
        if (request.method === "initialize") {
          const params = request.params as { protocolVersion?: unknown } | undefined;
          write({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion:
                typeof params?.protocolVersion === "string"
                  ? params.protocolVersion
                  : "2025-06-18",
              capabilities: {
                tools: {},
                experimental: { "claude/channel": {} },
              },
              serverInfo: { name: "agent-mesh", version: "0.1.0" },
              instructions:
                "Agent Mesh messages arrive as Claude channel turns. Use reply with the inbound turn_id exactly once for normal responses; use send_message only for proactive messages.",
            },
          });
          return;
        }
        if (request.method === "tools/list") {
          write({ jsonrpc: "2.0", id: request.id, result: { tools: TOOLS } });
          return;
        }
        if (request.method === "tools/call") {
          const params = request.params as
            | { name?: unknown; arguments?: Record<string, unknown> }
            | undefined;
          const args = params?.arguments ?? {};
          let result: unknown;
          switch (params?.name) {
            case "reply": {
              const turnId = requiredString(args, "turn_id");
              const text = requiredString(args, "text");
              const reply = await requestControl(options.runtimeDirectory, "runtime.reply", {
                lane_id: options.laneId,
                turn_id: turnId,
                text,
              });
              activeTurns.delete(turnId);
              result = content(JSON.stringify(reply));
              break;
            }
            case "send_message":
              result = content(
                JSON.stringify(
                  await requestControl(options.runtimeDirectory, "mesh.send", {
                    lane_id: options.laneId,
                    to: requiredString(args, "to"),
                    content: requiredString(args, "text"),
                    ...(typeof args.reply_to === "string"
                      ? { reply_to: args.reply_to }
                      : {}),
                  }),
                ),
              );
              break;
            case "list_agents":
              result = content(
                JSON.stringify(
                  await requestControl(options.runtimeDirectory, "mesh.list_agents", {
                    lane_id: options.laneId,
                  }),
                ),
              );
              break;
            case "fetch_messages":
              result = content(
                JSON.stringify(
                  await requestControl(options.runtimeDirectory, "mesh.inbox", {
                    lane_id: options.laneId,
                    limit:
                      typeof args.limit === "number"
                        ? Math.max(1, Math.min(200, Math.trunc(args.limit)))
                        : 20,
                  }),
                ),
              );
              break;
            default:
              throw new Error(`Unknown tool: ${String(params?.name)}`);
          }
          write({ jsonrpc: "2.0", id: request.id, result });
          return;
        }
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        });
      } catch (error) {
        write({
          jsonrpc: "2.0",
          id: request.id,
          result: content(error instanceof Error ? error.message : String(error), true),
        });
      }
    })();
  });

  await new Promise<void>((resolve) => {
    input.once("close", () => {
      stopped = true;
      clearInterval(timer);
      resolve();
    });
  });
}
