import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LaneOutbox } from "../src/outbox/lane-outbox";
import type { AuditEventInput, StagedAttachment } from "../src/outbox/types";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture(filename = "report.PDF", content = "hello blob") {
  const root = await mkdtemp("/tmp/agent-mesh-outbox-");
  cleanups.push(() => rm(root, { recursive: true }));
  const staging = join(root, "staging");
  const state = join(root, "state");
  await mkdir(staging, { recursive: true });
  const path = join(staging, filename);
  await writeFile(path, content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const attachment: StagedAttachment = {
    attachment_id: "provider-file-1",
    filename,
    media_type: "application/pdf",
    size: Buffer.byteLength(content),
    sha256,
    local_path: path,
  };
  return { root, staging, state, attachment };
}

function input(
  stagingRoot: string,
  attachment: StagedAttachment,
  dedupKey = "discord:message-1",
): AuditEventInput {
  return {
    direction: "inbound",
    sourceKind: "channel",
    driverInstanceId: "discord-main",
    rawParams: { provider_event_id: "message-1", text: "hello" },
    attachments: [attachment],
    stagingRoot,
    correlation: {
      account_ref: "account",
      conversation_ref: "channel",
      reply_to_provider_message_id: "message-1",
    },
    dedupKey,
  };
}

describe("LaneOutbox", () => {
  test("durably records an event and content-addressed Blob", async () => {
    const { staging, state, attachment } = await fixture();
    const outbox = new LaneOutbox("lane-a", state);
    await outbox.initialize();
    const event = await outbox.record(input(staging, attachment));

    expect(event.eventId).toMatch(/^aud_/);
    expect(event.inboundId).toMatch(/^in_/);
    expect(event.state).toBe("PENDING_BLOBS");
    expect(event.attachmentBlobKeys).toEqual([`${attachment.sha256}.pdf`]);
    expect(outbox.getBlob(`${attachment.sha256}.pdf`)).toMatchObject({
      size: attachment.size,
      localRefCount: 1,
      hubConfirmed: false,
    });
    outbox.close();

    const reopened = new LaneOutbox("lane-a", state);
    await reopened.initialize();
    expect(reopened.listDue()).toHaveLength(1);
    reopened.close();
  });

  test("returns the original durable result for a duplicate provider event", async () => {
    const { staging, state, attachment } = await fixture();
    const outbox = new LaneOutbox("lane-a", state);
    await outbox.initialize();
    const first = await outbox.record(input(staging, attachment));
    const duplicate = await outbox.record(input(staging, attachment));
    expect(duplicate.eventId).toBe(first.eventId);
    expect(duplicate.inboundId).toBe(first.inboundId);
    expect(outbox.getBlob(first.attachmentBlobKeys[0]!)?.localRefCount).toBe(1);
    outbox.close();
  });

  test("uses extension as part of the Blob key", async () => {
    const one = await fixture("same.pdf", "same bytes");
    const outbox = new LaneOutbox("lane-a", one.state);
    await outbox.initialize();
    const first = await outbox.record(input(one.staging, one.attachment, "event-1"));
    const secondPath = join(one.staging, "same.txt");
    await writeFile(secondPath, "same bytes");
    const secondAttachment = {
      ...one.attachment,
      filename: "same.txt",
      media_type: "text/plain",
      local_path: secondPath,
    };
    const second = await outbox.record(input(one.staging, secondAttachment, "event-2"));
    expect(first.attachmentBlobKeys[0]).toEndWith(".pdf");
    expect(second.attachmentBlobKeys[0]).toEndWith(".txt");
    expect(second.attachmentBlobKeys[0]).not.toBe(first.attachmentBlobKeys[0]);
    outbox.close();
  });

  test("rejects changed attachment metadata before ACK", async () => {
    const { staging, state, attachment } = await fixture();
    const outbox = new LaneOutbox("lane-a", state);
    await outbox.initialize();
    await expect(
      outbox.record(
        input(staging, { ...attachment, sha256: "0".repeat(64) }),
      ),
    ).rejects.toThrow("size or sha256 changed");
    expect(outbox.listDue()).toHaveLength(0);
    outbox.close();
  });

  test("keeps a stable action result for provider deduplication", async () => {
    const { state } = await fixture();
    const outbox = new LaneOutbox("lane-a", state);
    await outbox.initialize();
    expect(outbox.reserveAction("act-1", "discord-main", { text: "hi" })).toEqual({
      duplicate: false,
      result: null,
    });
    outbox.completeAction("act-1", { provider_message_id: "m1" });
    expect(outbox.reserveAction("act-1", "discord-main", { text: "hi" })).toEqual({
      duplicate: true,
      result: { provider_message_id: "m1" },
    });
    outbox.close();
  });

  // Dead-lettering quarantines rather than deletes, but until this existed
  // nothing could let an event back out — so a classification the client got
  // wrong (a code from a newer Hub, defaulted by its call site) stopped events
  // that were correct, and only a hand-written UPDATE could undo it.
  test("returns dead letters to the queue without erasing why they stopped", async () => {
    const { staging, state, attachment } = await fixture();
    const outbox = new LaneOutbox("lane-a", state);
    await outbox.initialize();
    const event = await outbox.record(input(staging, attachment));
    outbox.markDeadLetter(event.eventId, "AUDIT_APPEND_FAILED");
    expect(outbox.listDue()).toHaveLength(0);
    expect((await outbox.summary()).deadLetter).toBe(1);

    expect(outbox.replayDeadLetters()).toEqual({
      replayed: [event.eventId],
      skipped: [],
    });

    const due = outbox.listDue();
    expect(due).toHaveLength(1);
    // The blob was never confirmed, so the replay has to re-enter the upload
    // phase; appending first would fail with AUDIT_MISSING_BLOBS.
    expect(due[0]).toMatchObject({
      state: "PENDING_BLOBS",
      resumeState: "PENDING_BLOBS",
      attemptCount: 1,
      lastErrorCode: "AUDIT_APPEND_FAILED",
    });
    outbox.close();
  });

  test("skips the blob phase for a replay whose attachments are confirmed", async () => {
    const { staging, state, attachment } = await fixture();
    const outbox = new LaneOutbox("lane-a", state);
    await outbox.initialize();
    const event = await outbox.record(input(staging, attachment));
    outbox.markBlobConfirmed(event.attachmentBlobKeys[0]!, "hub-blob-1");
    outbox.markDeadLetter(event.eventId, "-32000");

    outbox.replayDeadLetters([event.eventId]);
    expect(outbox.listDue()[0]).toMatchObject({ state: "PENDING_APPEND" });
    outbox.close();
  });

  test("refuses to drag an acked event back out of the Hub's hands", async () => {
    const { staging, state, attachment } = await fixture();
    const outbox = new LaneOutbox("lane-a", state);
    await outbox.initialize();
    const event = await outbox.record(input(staging, attachment));
    outbox.markAcked(event.eventId);

    expect(outbox.replayDeadLetters([event.eventId, "aud_missing"])).toEqual({
      replayed: [],
      skipped: [event.eventId, "aud_missing"],
    });
    expect(outbox.listDue()).toHaveLength(0);
    outbox.close();
  });
});
