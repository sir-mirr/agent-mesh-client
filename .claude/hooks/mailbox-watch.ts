#!/usr/bin/env bun
/**
 * Idle-time mailbox watcher, for the Monitor tool.
 *
 * The hooks in `mailbox.ts` are event-driven: one fires when a turn starts, the
 * other when it ends. Neither fires while the session sits idle, so mail that
 * arrives with nobody typing waits for the next prompt — possibly hours, with
 * the other agent blocked that whole time on an answer already sent.
 *
 * This closes that gap. A shell-side poll costs nothing, so the model is woken
 * only when mail actually lands. A cron firing every ten minutes would instead
 * start a session each time to discover an empty inbox.
 *
 * **This reports; `mailbox.ts` delivers.** Bodies run to 10 MB and a
 * notification is not the place for one, so this sends ids and previews, the
 * model wakes, and the hook hands over the full text at the end of that turn.
 *
 * **It cannot replace the hook.** Its high-water mark lives in memory and is
 * re-seeded from whatever is in the inbox on start, so a restart silently
 * stops it announcing anything that arrived before it — while the hook's mark
 * is a file and survives. Read this watcher as a wake-up, never as delivery.
 *
 * Nothing here writes that file. This poll's own GET marks messages read in
 * the mailer, which is exactly why the hook keys off its mark rather than
 * `isRead`: otherwise this watcher would consume every message first.
 *
 * Ids come from a single counter in the mailer and only increase, so comparing
 * against a high-water mark stays correct however either side restarts.
 *
 * AGENT_ID defaults to this repository's identity for the same reason it does
 * in `mailbox.ts`: inheriting the upstream default would watch the other side's
 * inbox and consume the read flags its owner depends on.
 */

// A module, so that top-level `await` below is legal rather than merely
// tolerated. Bun runs this either way; `tsc` does not, and this file sat
// outside the checked scope long enough for that to go unnoticed.
export {};

const MAILBOX = process.env.AGENT_MESH_MAILBOX_URL ?? "http://localhost:3300/api/mail";
const AGENT_ID = process.env.AGENT_MESH_AGENT_ID ?? "client-claude";
const INTERVAL_MS = Number(process.env.AGENT_MESH_MAILBOX_POLL_SECONDS ?? 30) * 1000;
const PREVIEW_CHARS = 240;

interface Mail {
  id: number;
  from: string;
  body: string;
  createdAt: number;
}

/** Bun buffers console.log into a pipe; Monitor reads lines, so write through. */
async function emit(line: string): Promise<void> {
  await Bun.write(Bun.stdout, `${line}\n`);
}

let highWater = 0;

// Start from whatever is already sitting there rather than announcing it. On
// arming, the backlog is either about to be delivered by the Stop hook or was
// already read this session; re-reporting it would fire a notification for old
// mail every time the watcher restarts.
try {
  const res = await fetch(`${MAILBOX}?agentId=${encodeURIComponent(AGENT_ID)}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (res.ok) {
    for (const m of ((await res.json()) as { messages?: Mail[] }).messages ?? []) {
      if (m.id > highWater) highWater = m.id;
    }
  }
} catch {
  // No mailer yet. It may start later; the loop below keeps trying.
}

await emit(`watching ${MAILBOX} for ${AGENT_ID}, every ${INTERVAL_MS / 1000}s (from id ${highWater})`);

while (true) {
  await Bun.sleep(INTERVAL_MS);

  let messages: Mail[];
  try {
    const res = await fetch(`${MAILBOX}?agentId=${encodeURIComponent(AGENT_ID)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) continue;
    messages = ((await res.json()) as { messages?: Mail[] }).messages ?? [];
  } catch {
    // A mailer restart or a dropped request is not worth a notification, and
    // exiting here would take the watch down for the rest of the session.
    continue;
  }

  const fresh = messages.filter((m) => m.id > highWater).sort((a, b) => a.id - b.id);
  if (fresh.length === 0) continue;
  highWater = fresh[fresh.length - 1]!.id;

  // One write per message: Monitor groups stdout arriving within 200ms into a
  // single notification, so a burst still reads as one event.
  for (const m of fresh) {
    const preview = m.body.replace(/\s+/g, " ").slice(0, PREVIEW_CHARS);
    const ellipsis = m.body.length > PREVIEW_CHARS ? " …" : "";
    await emit(`mail #${m.id} from ${m.from} (${m.body.length} chars): ${preview}${ellipsis}`);
  }
}
