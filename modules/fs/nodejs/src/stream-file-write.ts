import { ERR_INPUT_INVALID, InvokeError, type Logger } from "@telorun/sdk";
import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readlink, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { wrapFsError } from "./fs-support.js";
import { HeldSource } from "./held-source.js";

/** How many symbolic links a write follows before it gives up, as the host does. */
const MAX_LINK_HOPS = 40;

export interface StreamWrite {
  /** The kind named in messages. */
  kind: string;
  /** The resolved path the caller asked to write. */
  target: string;
  source: AsyncIterable<unknown>;
  maxBytes: number | undefined;
  /** Create the target's missing parent directories first. */
  createParents: boolean;
  log: Logger;
}

/** True for a value consumed by iterating — a stream — as opposed to text or one
 *  run of bytes. */
export function isByteStream(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Uint8Array) &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

/** The refusal of content over `maxBytes`. `size` is known only for content held
 *  whole; a stream is refused on the chunk that crosses the bound. */
export function fileTooLarge(
  kind: string,
  target: string,
  maxBytes: number,
  size?: number,
): InvokeError {
  return size === undefined
    ? new InvokeError(
        "ERR_FILE_TOO_LARGE",
        `${kind}: the stream written to '${target}' is over the ${maxBytes} bytes 'maxBytes' allows; the file was not replaced.`,
        { path: target, maxBytes },
      )
    : new InvokeError(
        "ERR_FILE_TOO_LARGE",
        `${kind}: the content for '${target}' is ${size} bytes, over the ${maxBytes} bytes 'maxBytes' allows; nothing was written.`,
        { path: target, maxBytes, size },
      );
}

/**
 * Writes a byte stream to `target` and returns the bytes written.
 *
 * The bytes are staged in a sibling `.<basename>.<random>.tmp` and renamed over
 * the target once the stream has ended, so a reader sees the old file or the new
 * one and never part of either. An existing target that is not a regular file — a
 * FIFO, a device, a socket — has no content to replace and is written in place.
 *
 * A failure of the source is rethrown as it was raised; every failure of the
 * filesystem is the kind's write error. On any failure — one before the first
 * byte is read included — a source that has not ended is released, and then the
 * staging file is removed.
 */
export async function writeStream(write: StreamWrite): Promise<number> {
  const source = new HeldSource(write.source);
  const staged: Staged = {};
  try {
    return await land(write, source, staged);
  } catch (err) {
    await release(source, write);
    if (staged.file !== undefined) await removeStaging(staged.file, write.log);
    throw err;
  }
}

/** The staging file a write has open or has filled, until it is renamed. */
interface Staged {
  file?: string;
}

async function land(write: StreamWrite, source: HeldSource, staged: Staged): Promise<number> {
  const { kind, target } = write;
  const failed = (err: unknown) => wrapFsError(`${kind}: cannot write`, target, err);

  let destination: Destination;
  try {
    if (write.createParents) await mkdir(path.dirname(target), { recursive: true });
    destination = await followLinks(target);
  } catch (err) {
    throw failed(err);
  }
  const { file, existing } = destination;
  if (existing && !existing.isFile()) return writeInPlace(write, source, file);

  const staging = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle: FileHandle;
  try {
    handle = await open(staging, "wx");
  } catch (err) {
    throw failed(err);
  }
  staged.file = staging;
  const drained = await fill(write, source, handle, async () => {
    if (existing) await handle.chmod(existing.mode & 0o7777);
  });
  if (drained.over) throw fileTooLarge(kind, target, write.maxBytes as number);
  try {
    await rename(staging, file);
  } catch (err) {
    throw failed(err);
  }
  staged.file = undefined;
  return drained.total;
}

async function writeInPlace(write: StreamWrite, source: HeldSource, file: string): Promise<number> {
  const { kind, target } = write;
  let handle: FileHandle;
  try {
    handle = await open(file, "w");
  } catch (err) {
    throw wrapFsError(`${kind}: cannot write`, target, err);
  }
  const drained = await fill(write, source, handle, async () => {});
  if (drained.over) throw fileTooLarge(kind, target, write.maxBytes as number);
  return drained.total;
}

interface Destination {
  /** The file the bytes land in: the target, or what a symbolic link names. */
  file: string;
  existing: Stats | undefined;
}

/** A symbolic link is written through: the file it names is the one replaced,
 *  and the link stays a link. A link naming nothing creates what it names. */
async function followLinks(target: string): Promise<Destination> {
  let file = target;
  for (let hops = 0; hops <= MAX_LINK_HOPS; hops++) {
    let stats: Stats;
    try {
      stats = await lstat(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { file, existing: undefined };
      throw err;
    }
    if (!stats.isSymbolicLink()) return { file, existing: stats };
    file = path.resolve(path.dirname(file), await readlink(file));
  }
  throw Object.assign(new Error("too many levels of symbolic links"), { code: "ELOOP" });
}

interface Drained {
  total: number;
  /** The stream crossed `maxBytes`; the crossing chunk was not written. */
  over: boolean;
}

/** Drains the source into an open file and closes it, whatever happens. */
async function fill(
  write: StreamWrite,
  source: HeldSource,
  handle: FileHandle,
  prepare: () => Promise<void>,
): Promise<Drained> {
  const failed = (err: unknown) => wrapFsError(`${write.kind}: cannot write`, write.target, err);
  let drained: Drained;
  try {
    try {
      await prepare();
    } catch (err) {
      throw failed(err);
    }
    drained = await drain(write, source, async (chunk) => {
      try {
        await writeAll(handle, chunk);
      } catch (err) {
        throw failed(err);
      }
    });
  } catch (err) {
    await handle.close();
    throw err;
  }
  try {
    await handle.close();
  } catch (err) {
    throw failed(err);
  }
  return drained;
}

/**
 * Pulls the source chunk by chunk. A chunk is counted before it is handed on,
 * so at most `maxBytes` plus one chunk is ever pulled. A chunk that is not bytes
 * is refused under the input contract's code.
 */
async function drain(
  write: StreamWrite,
  source: HeldSource,
  sink: (chunk: Uint8Array) => Promise<void>,
): Promise<Drained> {
  let total = 0;
  for (;;) {
    const next = await source.next();
    if (next.done) return { total, over: false };
    const chunk = byteChunk(write.kind, next.value);
    if (write.maxBytes !== undefined && total + chunk.byteLength > write.maxBytes) {
      return { total, over: true };
    }
    await sink(chunk);
    total += chunk.byteLength;
  }
}

function byteChunk(kind: string, value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw invalidContent(
    kind,
    `is a stream that yielded ${value === null ? "null" : typeof value} — expected bytes`,
  );
}

/** The refusal the input contract would make of `content`, were a stream not a
 *  live value it never inspects: of a value that is none of the declared forms,
 *  and of a stream chunk that is not bytes. */
export function invalidContent(kind: string, problem: string): InvokeError {
  const message = `${kind}: 'content' ${problem}.`;
  return new InvokeError(ERR_INPUT_INVALID, message, { issues: [{ path: "content", message }] });
}

/** A write may accept fewer bytes than it was handed — a pipe does. */
async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    offset += bytesWritten;
  }
}

/** Runs while another error is already on its way out, so a release that fails
 *  is reported in the log rather than raised over it. */
async function release(source: HeldSource, write: StreamWrite): Promise<void> {
  try {
    await source.release();
  } catch (err) {
    write.log.warn("Source not released", { "file.path": write.target }, { error: err });
  }
}

/** Runs while another error is already on its way out, so a staging file that
 *  cannot be removed is reported in the log rather than raised over it. */
async function removeStaging(staging: string, log: Logger): Promise<void> {
  try {
    await rm(staging, { force: true });
  } catch (err) {
    log.warn("Staging file left behind", { "file.path": staging }, { error: err });
  }
}
