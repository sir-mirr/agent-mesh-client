import { createHash } from "node:crypto";
import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_EVENT,
  MAX_ATTACHMENT_TOTAL_BYTES,
} from "../constants";
import { prefixedId } from "../util/ids";
import { normalizeExtension as normalizeContractExtension } from "@agent-mesh/contracts";
import type { StagedAttachment, StoredBlob } from "./types";

export class AttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

export function normalizeExtension(filename: string): string {
  return normalizeContractExtension(filename);
}

export function validateAttachmentSet(attachments: readonly StagedAttachment[]): void {
  if (attachments.length > MAX_ATTACHMENTS_PER_EVENT) {
    throw new AttachmentValidationError(
      `Attachment count exceeds ${MAX_ATTACHMENTS_PER_EVENT}`,
    );
  }
  let total = 0;
  for (const attachment of attachments) {
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
      throw new AttachmentValidationError("Attachment size must be a non-negative integer");
    }
    if (attachment.size > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentValidationError(
        `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes: ${attachment.filename}`,
      );
    }
    if (!/^[0-9a-f]{64}$/.test(attachment.sha256)) {
      throw new AttachmentValidationError("Attachment sha256 must be lowercase hex");
    }
    total += attachment.size;
  }
  if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new AttachmentValidationError(
      `Attachment total exceeds ${MAX_ATTACHMENT_TOTAL_BYTES} bytes`,
    );
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertWithinRoot(root: string, candidate: string): void {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  ) {
    return;
  }
  throw new AttachmentValidationError("Attachment path escapes registered staging_root");
}

export class BlobSpool {
  readonly blobDirectory: string;
  readonly temporaryDirectory: string;

  constructor(readonly rootDirectory: string) {
    this.blobDirectory = resolve(rootDirectory, "blobs");
    this.temporaryDirectory = resolve(rootDirectory, "tmp");
  }

  async initialize(): Promise<void> {
    await mkdir(this.blobDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.temporaryDirectory, { recursive: true, mode: 0o700 });
  }

  async ingest(
    attachment: StagedAttachment,
    stagingRoot: string,
  ): Promise<StoredBlob> {
    const root = await realpath(stagingRoot);
    const requestedLstat = await lstat(attachment.local_path);
    if (requestedLstat.isSymbolicLink()) {
      throw new AttachmentValidationError("Attachment must not be a symlink");
    }
    const source = await realpath(attachment.local_path);
    assertWithinRoot(root, source);
    const sourceLstat = await lstat(source);
    if (!sourceLstat.isFile() || sourceLstat.isSymbolicLink()) {
      throw new AttachmentValidationError("Attachment must be a non-symlink regular file");
    }

    const sourceHandle = await open(
      source,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const temporaryPath = resolve(
      this.temporaryDirectory,
      `${prefixedId("blob")}.${basename(source)}.tmp`,
    );
    const temporaryHandle = await open(temporaryPath, "wx", 0o600);
    let size = 0;
    const hash = createHash("sha256");
    try {
      const openedStat = await sourceHandle.stat();
      if (!openedStat.isFile()) {
        throw new AttachmentValidationError("Opened attachment is not a regular file");
      }
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await sourceHandle.read(
          buffer,
          0,
          buffer.byteLength,
          position,
        );
        if (bytesRead === 0) break;
        position += bytesRead;
        size += bytesRead;
        if (size > MAX_ATTACHMENT_BYTES) {
          throw new AttachmentValidationError("Attachment grew beyond the 100 MiB limit");
        }
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        await temporaryHandle.write(chunk);
      }
      await temporaryHandle.sync();
    } catch (error) {
      await temporaryHandle.close();
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    } finally {
      await sourceHandle.close();
    }
    await temporaryHandle.close();

    const digest = hash.digest("hex");
    if (size !== attachment.size || digest !== attachment.sha256) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new AttachmentValidationError("Attachment size or sha256 changed during ingest");
    }
    const normalizedExtension = normalizeExtension(attachment.filename);
    const blobKey = `${digest}${normalizedExtension}`;
    const shardDirectory = resolve(this.blobDirectory, digest.slice(0, 2));
    const spoolPath = resolve(shardDirectory, blobKey);
    await mkdir(shardDirectory, { recursive: true, mode: 0o700 });
    try {
      await link(temporaryPath, spoolPath);
      await syncDirectory(shardDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
      const existing = await stat(spoolPath);
      if (!existing.isFile() || existing.size !== size) {
        await unlink(temporaryPath).catch(() => undefined);
        throw new AttachmentValidationError("Existing Blob conflicts with content key");
      }
    }
    await unlink(temporaryPath);
    await syncDirectory(this.temporaryDirectory);
    return {
      blobKey,
      sha256: digest,
      normalizedExtension,
      size,
      spoolPath,
      localRefCount: 0,
      hubConfirmed: false,
      hubBlobKey: null,
    };
  }
}
