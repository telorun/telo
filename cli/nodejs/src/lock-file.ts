import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { removeLeftovers } from "./atomic-file.js";

/**
 * A lock file one telo process holds while it changes a per-user store
 * (`share-names.json`, `credentials.json`): created exclusively, holding the
 * holder's pid and a token of its own, its mtime refreshed while held so only a
 * crashed holder's lock goes stale.
 */
export interface LockFileOptions {
  /** A lock untouched for longer is a crashed holder's, and is taken over. */
  staleMs: number;
  /** How long to wait for another holder before giving up with {@link LockFileBusy}. */
  waitMs: number;
  /** Stops the wait; the lock is then not taken and the signal's reason thrown. */
  signal?: AbortSignal;
}

/** Another process held the lock for the whole wait. */
export class LockFileBusy extends Error {
  constructor(
    readonly lock: string,
    readonly waitedMs: number,
  ) {
    super(`another telo process holds ${lock} and did not release it within ${Math.round(waitedMs / 1000)} s`);
  }
}

/** A lock this process holds. */
export interface LockHold {
  /** Removes the lock, only while it is still this holder's. */
  release(): Promise<void>;
  /** Throws an `Error` when the lock was taken over since it was taken (it sat
   *  untouched past the stale age), so a write made on its authority must not land. */
  assertHeld(): Promise<void>;
}

const RETRY_MS = 20;

/** Takes `lock`, answering the hold. Throws {@link LockFileBusy} after the wait,
 *  the signal's reason when it aborts, and an `Error` naming the file for
 *  anything the filesystem refuses. Taking it removes the `<lock>.*.stale` files
 *  a crashed takeover left beside it. */
export async function takeLockFile(lock: string, options: LockFileOptions): Promise<LockHold> {
  const token = `${process.pid} ${randomUUID()}\n`;
  const started = Date.now();
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      await fsp.writeFile(lock, token, { flag: "wx" });
      const hold = holding(lock, token, options.staleMs);
      try {
        await removeLeftovers(path.dirname(lock), `${path.basename(lock)}.`, ".stale");
      } catch (error) {
        await hold.release();
        throw lockError(lock, error);
      }
      return hold;
    } catch (error) {
      if (!lockHeld(error)) throw lockError(lock, error);
    }
    if (await takeOverStale(lock, options.staleMs)) continue;
    if (Date.now() - started >= options.waitMs) throw new LockFileBusy(lock, options.waitMs);
    await pause(RETRY_MS, options.signal);
  }
}

/** Keeps the lock fresh while held; the release removes it only while it is still this holder's. */
function holding(lock: string, token: string, staleMs: number): LockHold {
  const heartbeat = setInterval(() => {
    const now = new Date();
    fsp.utimes(lock, now, now).catch(() => undefined);
  }, Math.max(1_000, Math.floor(staleMs / 3)));
  heartbeat.unref();
  const content = async (): Promise<string | undefined> => {
    try {
      return await fsp.readFile(lock, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw lockError(lock, error);
    }
  };
  return {
    async release() {
      clearInterval(heartbeat);
      if ((await content()) === token) await fsp.rm(lock, { force: true });
    },
    async assertHeld() {
      if ((await content()) !== token) {
        throw new Error(`the lock ${lock} was taken over while it was held; nothing was written`);
      }
    },
  };
}

/**
 * Moves a stale lock aside and deletes it. The content is read before the age,
 * so a lock replaced in between reads as fresh. The move is atomic, so of several
 * processes finding one stale lock only one moves it; when what it moved is not
 * the file it judged (another process took the lock, or its holder touched it,
 * since), it is put back.
 */
async function takeOverStale(lock: string, staleMs: number): Promise<boolean> {
  let judged: Stats;
  try {
    await fsp.readFile(lock, "utf8");
    judged = await fsp.stat(lock);
    if (Date.now() - judged.mtimeMs <= staleMs) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    if (lockHeld(error)) return false;
    throw lockError(lock, error);
  }
  const aside = `${lock}.${process.pid}.${randomUUID()}.stale`;
  try {
    await fsp.rename(lock, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    if (lockHeld(error)) return false;
    throw lockError(lock, error);
  }
  let moved: Stats;
  try {
    moved = await fsp.stat(aside);
  } catch (error) {
    // Swept by the process that took the lock meanwhile.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw lockError(lock, error);
  }
  if (moved.ino !== judged.ino || moved.mtimeMs !== judged.mtimeMs) {
    try {
      await fsp.link(aside, lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw lockError(lock, error);
    }
  }
  await fsp.rm(aside, { force: true });
  return true;
}

/** Another process holds the lock. Windows answers EPERM for a lock file whose
 *  deletion by its holder is still pending. */
function lockHeld(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || (process.platform === "win32" && code === "EPERM");
}

function lockError(lock: string, error: unknown): Error {
  return new Error(`cannot lock ${lock}: ${error instanceof Error ? error.message : String(error)}`);
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timer);
      reject(signal!.reason);
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}
