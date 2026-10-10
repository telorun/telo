import type { BlobAbsent, BlobContent, BlobFound, BlobPutOptions, BlobStore } from "@telorun/blob";
import type { Logger, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { blobPath, encodeHeader, readHeader } from "./blob-file.js";

interface StoreResource {
  metadata: { name: string; module?: string };
  root: string;
}

/** The directory, under the root, that holds blobs still being written. */
const STAGING_DIRECTORY = ".tmp";
/** A staging file untouched for this long belongs to a writer that is gone. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** The least time between two sweeps of the staging directory by one store. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const READ_CHUNK_BYTES = 64 * 1024;

const missing = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

/**
 * BlobFs.Store — one file per blob under a root directory several processes may
 * share. A file is a header line, then the content (`blob-file.ts`).
 *
 * A put writes a staging file under `.tmp/`, syncs it and renames it into
 * place; the rename is the only commit, so a reader opens the old file or the
 * new one, concurrent puts to one key leave one whole blob, and a put whose
 * source fails leaves nothing but the previous blob. The source is never this
 * store's to release: a put that fails discards its staging file and throws.
 *
 * A get leaves nothing open. It reads the header and closes the file; the
 * content opens it again at its first pull and fails that pull unless the file
 * then holds a blob of the size and media type that were reported.
 *
 * Every method ignores the invocation context it is handed: nothing here is a
 * remote call to cancel.
 */
class FsBlobStore implements BlobStore, ResourceInstance {
  private readonly root: string;
  /** When this store may next sweep its staging directory; at once, to begin with. */
  private sweepDue = 0;

  constructor(
    resource: StoreResource,
    private readonly log: Logger,
  ) {
    this.root = path.resolve(resource.root);
  }

  async put(
    key: string,
    content: AsyncIterable<Uint8Array>,
    options: BlobPutOptions,
  ): Promise<void> {
    const header = encodeHeader(key, options.contentType);
    const stagingDirectory = path.join(this.root, STAGING_DIRECTORY);
    await mkdir(stagingDirectory, { recursive: true });
    const staging = path.join(stagingDirectory, randomBytes(16).toString("hex"));
    const handle = await open(staging, "wx");
    let committed = false;
    try {
      try {
        await writeAll(handle, header);
        for await (const chunk of content) await writeAll(handle, chunk);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const file = blobPath(this.root, key);
      await mkdir(path.dirname(file), { recursive: true });
      await this.commit(staging, file, key);
      committed = true;
    } finally {
      if (!committed) await this.discard(staging);
    }
    const now = Date.now();
    if (now >= this.sweepDue) {
      this.sweepDue = now + SWEEP_INTERVAL_MS;
      await this.sweep(stagingDirectory, now);
    }
  }

  /** The rename that stores the blob. A staging file that is gone was taken
   *  for a dead writer's by a sweep, this store's or another process's. */
  private async commit(staging: string, file: string, key: string): Promise<void> {
    try {
      await rename(staging, file);
    } catch (err) {
      if (missing(err) && !(await exists(staging))) {
        throw new Error(
          `BlobFs.Store: the staging file for '${key}' was removed before the put finished — ` +
            `a put that writes nothing for 24 hours is taken for abandoned; nothing was stored.`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  async get(key: string): Promise<BlobContent | BlobAbsent> {
    const described = await this.describe(key);
    if (!described) return { status: "absent" };
    const { size, contentType } = described;
    return {
      status: "found",
      size,
      contentType,
      content: contentOf(() => this.openDescribed(key, size, contentType), size),
    };
  }

  async head(key: string): Promise<BlobFound | BlobAbsent> {
    const described = await this.describe(key);
    if (!described) return { status: "absent" };
    return { status: "found", size: described.size, contentType: described.contentType };
  }

  /** What the file under `key` holds now, with the file closed again. */
  private async describe(key: string): Promise<Described | undefined> {
    const file = blobPath(this.root, key);
    const handle = await openBlob(file);
    if (!handle) return undefined;
    try {
      const header = await readHeader(handle, file, key);
      const size = (await handle.stat()).size - header.length;
      return { size, contentType: header.contentType };
    } finally {
      await handle.close();
    }
  }

  /** Opens the blob a get described, for its content's first pull: the file
   *  then stored under the key must hold a blob of that size and media type. */
  private async openDescribed(key: string, size: number, contentType: string): Promise<OpenBlob> {
    const file = blobPath(this.root, key);
    const handle = await openBlob(file);
    if (!handle) {
      throw new Error(
        `BlobFs.Store: the blob under '${key}' was deleted before its content was first read.`,
      );
    }
    try {
      const header = await readHeader(handle, file, key);
      const now = (await handle.stat()).size - header.length;
      if (now !== size || header.contentType !== contentType) {
        throw new Error(
          `BlobFs.Store: the blob under '${key}' was replaced before its content was first read — ` +
            `it was ${size} bytes of ${contentType} and is now ${now} bytes of ${header.contentType}.`,
        );
      }
      return { handle, start: header.length };
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(blobPath(this.root, key));
    } catch (err) {
      if (!missing(err)) throw err;
    }
  }

  /** Runs while a failure is already on its way out, so a staging file that
   *  cannot be removed is reported in the log rather than raised over it. */
  private async discard(staging: string): Promise<void> {
    try {
      await rm(staging, { force: true });
    } catch (err) {
      this.log.warn("Staging file left behind", { "file.path": staging }, { error: err });
    }
  }

  /** Removes what dead writers left behind. Runs after the put is committed, so
   *  a failure here is logged: the blob is stored whatever becomes of it. */
  private async sweep(stagingDirectory: string, now: number): Promise<void> {
    try {
      const cutoff = now - STALE_AFTER_MS;
      for (const name of await readdir(stagingDirectory)) {
        const entry = path.join(stagingDirectory, name);
        let modified: number;
        try {
          modified = (await stat(entry)).mtimeMs;
        } catch (err) {
          // Committed or swept by another process since it was listed.
          if (missing(err)) continue;
          throw err;
        }
        if (modified <= cutoff) await rm(entry, { force: true, recursive: true });
      }
    } catch (err) {
      this.log.warn(
        "Stale staging files not removed",
        { "file.path": stagingDirectory },
        { error: err },
      );
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    offset += bytesWritten;
  }
}

/** What a blob file was found to hold. */
interface Described {
  size: number;
  contentType: string;
}

/** A blob file open for reading, and where its content begins. */
interface OpenBlob {
  handle: FileHandle;
  start: number;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (err) {
    if (missing(err)) return false;
    throw err;
  }
}

async function openBlob(file: string): Promise<FileHandle | undefined> {
  try {
    return await open(file, "r");
  } catch (err) {
    if (missing(err)) return undefined;
    throw err;
  }
}

/**
 * A blob's content, read as it is pulled.
 *
 * Nothing is open until the first pull, which opens the file through `open`;
 * so content that is never pulled holds nothing, and a release before the first
 * pull has nothing to close. From the first pull the handle stays open across
 * the read, so a blob replaced or deleted meanwhile is still read whole.
 */
function contentOf(open: () => Promise<OpenBlob>, size: number): AsyncIterable<Uint8Array> {
  let reading: { handle: FileHandle; position: number; end: number } | undefined;
  let finished = false;
  const close = async () => {
    finished = true;
    const handle = reading?.handle;
    reading = undefined;
    await handle?.close();
  };
  const done: IteratorResult<Uint8Array> = { done: true, value: undefined };
  const iterator: AsyncIterator<Uint8Array> = {
    async next() {
      if (finished) return done;
      if (!reading) {
        let opened: OpenBlob;
        try {
          opened = await open();
        } catch (err) {
          finished = true;
          throw err;
        }
        reading = { handle: opened.handle, position: opened.start, end: opened.start + size };
      }
      const wanted = Math.min(READ_CHUNK_BYTES, reading.end - reading.position);
      if (wanted === 0) {
        await close();
        return done;
      }
      let bytesRead: number;
      const buffer = Buffer.allocUnsafe(wanted);
      try {
        ({ bytesRead } = await reading.handle.read(buffer, 0, wanted, reading.position));
      } catch (err) {
        await close();
        throw err;
      }
      if (bytesRead === 0) {
        const short = reading.end - reading.position;
        await close();
        throw new Error(`BlobFs.Store: a blob file ended ${short} bytes before its recorded size.`);
      }
      reading.position += bytesRead;
      return { done: false, value: buffer.subarray(0, bytesRead) };
    },
    async return() {
      await close();
      return done;
    },
  };
  return { [Symbol.asyncIterator]: () => iterator };
}

export async function create(resource: StoreResource, ctx: ResourceContext): Promise<FsBlobStore> {
  return new FsBlobStore(resource, ctx.log);
}
