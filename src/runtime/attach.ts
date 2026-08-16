import { stat } from "node:fs/promises";
import { appServerSocketPath, laneTmuxSession } from "../config/paths";
import type { LaneConfig } from "../config/types";
import { loadedThreadIds } from "./ws-unix-client";

/**
 * What `attach` opens, per runtime.
 *
 * The three lanes hold different things and the differences are not cosmetic:
 * Claude keeps a CLI in tmux, Codex keeps a thread on an app-server that the
 * daemon and the operator both connect to, and Antigravity keeps nothing at
 * all between turns. Deciding this in one place is why the TUI and the CLI
 * agree; when the CLI had it and the TUI did not, `attach` in the TUI worked
 * for exactly one of the three.
 */

export interface AttachContext {
  lane: LaneConfig;
  runtimeDirectory: string;
  /**
   * The conversation to open. The daemon reports the one it is holding, which
   * exists from lane start -- so this is set before any message has arrived.
   */
  conversationId?: string | null | undefined;
  /** Session the daemon already owns, when it owns one. */
  daemonSession?: string | null | undefined;
  /** Re-invocation of this program, for runtimes observed rather than joined. */
  selfCommand: readonly string[];
}

export class AttachUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachUnavailableError";
  }
}

function tmuxOrThrow(): string {
  const tmux = Bun.which("tmux");
  if (!tmux) throw new AttachUnavailableError("tmux is not installed");
  return tmux;
}

function hasSession(tmux: string, session: string): boolean {
  return (
    Bun.spawnSync([tmux, "has-session", "-t", session], {
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0
  );
}

/**
 * Session names are `mesh-lane-<identity>` -- the identity, not a digest of
 * it. A digest is unambiguous and unreadable, and `tmux ls` is where someone
 * looks when they want to know which agent a window belongs to. Identities are
 * `[A-Za-z0-9-]` and unique per host, so the name is already both.
 *
 * A collision is therefore not this program's two lanes meeting; it is
 * something else on the machine holding the name. Reported rather than
 * absorbed: attaching to a stranger's session looks like the agent behaving
 * strangely.
 */
function createSession(
  tmux: string,
  session: string,
  cwd: string,
  command: readonly string[],
): void {
  const created = Bun.spawnSync([tmux, "new-session", "-d", "-s", session, "-c", cwd, ...command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (created.exitCode === 0) return;
  const detail = new TextDecoder().decode(created.stderr).trim();
  if (/duplicate session/i.test(detail)) {
    throw new AttachUnavailableError(
      `A tmux session named ${session} already exists and is not this agent's. ` +
        `Rename or close it, then attach again.`,
    );
  }
  throw new AttachUnavailableError(detail || `tmux exited ${created.exitCode}`);
}

/**
 * Ensures there is something to attach to, and returns its session name.
 *
 * Throws `AttachUnavailableError` when the caller should show the reason
 * rather than open a terminal.
 */
export async function ensureAttachTarget(context: AttachContext): Promise<string> {
  const tmux = tmuxOrThrow();
  const session = laneTmuxSession(context.lane.identity);
  const workspace = context.lane.runtime.workspace;

  if (context.lane.runtime.kind === "claude") {
    // The daemon owns this one: it holds the CLI, and a session it did not
    // start is not the agent.
    const owned = context.daemonSession ?? session;
    if (!hasSession(tmux, owned)) {
      throw new AttachUnavailableError(
        "This agent's CLI is not running. Start the runtime first.",
      );
    }
    return owned;
  }

  if (context.lane.runtime.kind === "codex") {
    const socket = appServerSocketPath(context.runtimeDirectory, context.lane.id);
    // `Bun.file().exists()` answers for regular files and a socket is not one.
    const listening = await stat(socket).then(() => true, () => false);
    if (!listening) {
      throw new AttachUnavailableError(
        "The Codex app-server is not listening yet. It starts with the lane's first turn.",
      );
    }
    if (hasSession(tmux, session)) return session;
    const codex = context.lane.runtime.command ?? Bun.which("codex");
    if (!codex) throw new AttachUnavailableError("codex is not installed");
    // Open the daemon's thread, not a new one. Its id comes from the lane's
    // turns: the server's loaded list also holds threads whose viewer exited,
    // and those have no rollout, so resuming one fails and takes the pane with
    // it. The list only confirms the daemon's thread is still live.
    const loaded = await loadedThreadIds(socket);
    const thread =
      context.conversationId && loaded.includes(context.conversationId)
        ? context.conversationId
        : undefined;
    // The daemon holds a conversation from lane start, so this is normally
    // set. When it is not -- a server that dropped the thread, a lane still
    // coming up -- opening a viewer anyway would put it on a thread of its
    // own, where the turns that arrive later are not.
    if (!thread) {
      throw new AttachUnavailableError(
        "This agent's conversation is not up yet. Try again in a moment.",
      );
    }
    createSession(tmux, session, workspace, [
      codex,
      "--remote",
      `unix://${socket}`,
      "--no-alt-screen",
      ...(thread ? ["resume", thread] : []),
    ]);
    return session;
  }

  // Antigravity: one `agy --print` child per turn and nothing resident, so
  // what an operator attaches to is the redacted queue rather than a session.
  if (hasSession(tmux, session)) return session;
  createSession(tmux, session, workspace, [
    ...context.selfCommand,
    "runtime",
    "observe",
    "--lane",
    context.lane.id,
    "--runtime-dir",
    context.runtimeDirectory,
  ]);
  return session;
}

/**
 * How to re-invoke this program. Compiled, the binary re-runs itself; under
 * `bun run src/cli.ts` the entry point has to be handed back to bun.
 */
export function selfCommand(): readonly string[] {
  const entry = process.argv[1];
  return entry?.endsWith(".ts") ? [process.execPath, entry] : [process.execPath];
}
