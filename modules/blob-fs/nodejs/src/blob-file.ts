import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

/** The longest a header line may be, its newline included. */
export const HEADER_LIMIT = 4096;

const HEADER_VERSION = 1;
const NEWLINE = 0x0a;

/** Where the blob under `key` lives: the lower-case hex SHA-256 of the key,
 *  split 2 / 2 / 60. Any valid key maps to a path of fixed shape, so no key is
 *  too long or too deep for the filesystem and no two keys share a file. */
export function blobPath(root: string, key: string): string {
  const hash = createHash("sha256").update(key, "utf8").digest("hex");
  return path.join(root, hash.slice(0, 2), hash.slice(2, 4), hash.slice(4));
}

/** The header line a blob file starts with: one line of JSON, then the content. */
export function encodeHeader(key: string, contentType: string): Buffer {
  const header = Buffer.from(
    `${JSON.stringify({ v: HEADER_VERSION, key, contentType })}\n`,
    "utf8",
  );
  if (header.byteLength > HEADER_LIMIT) {
    throw new Error(
      `BlobFs.Store: the header for '${key}' is ${header.byteLength} bytes, over the ${HEADER_LIMIT} a blob file holds.`,
    );
  }
  return header;
}

export interface BlobHeader {
  contentType: string;
  /** Bytes the header line occupies; the content starts here. */
  length: number;
}

/** Reads the header of the open blob file at `file`, stored for `key`. */
export async function readHeader(handle: FileHandle, file: string, key: string): Promise<BlobHeader> {
  const buffer = Buffer.alloc(HEADER_LIMIT);
  let filled = 0;
  let end = -1;
  while (end === -1 && filled < HEADER_LIMIT) {
    const { bytesRead } = await handle.read(buffer, filled, HEADER_LIMIT - filled, filled);
    if (bytesRead === 0) break;
    end = buffer.subarray(filled, filled + bytesRead).indexOf(NEWLINE);
    if (end !== -1) end += filled;
    filled += bytesRead;
  }
  if (end === -1) {
    throw new Error(
      `BlobFs.Store: '${file}' is not a blob file — no header line within its first ${HEADER_LIMIT} bytes.`,
    );
  }
  let header: unknown;
  try {
    header = JSON.parse(buffer.subarray(0, end).toString("utf8"));
  } catch (err) {
    throw new Error(`BlobFs.Store: '${file}' is not a blob file — its header line is not JSON.`, {
      cause: err,
    });
  }
  const { v, key: stored, contentType } = (header ?? {}) as Record<string, unknown>;
  if (v !== HEADER_VERSION || typeof stored !== "string" || typeof contentType !== "string") {
    throw new Error(
      `BlobFs.Store: '${file}' has a header this version does not read (expected v ${HEADER_VERSION} with 'key' and 'contentType').`,
    );
  }
  if (stored !== key) {
    throw new Error(
      `BlobFs.Store: '${file}' holds the blob '${stored}', not the requested '${key}'.`,
    );
  }
  return { contentType, length: end + 1 };
}
