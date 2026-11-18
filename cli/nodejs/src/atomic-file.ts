import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type { LockHold } from "./lock-file.js";

export interface AtomicWriteOptions {
  /** The lock guarding the store, held by the caller; it must still be this holder's when the file is replaced. */
  lock: LockHold;
  /** The file's mode; the platform default when absent. */
  mode?: number;
}

/**
 * Writes `text` to `file` so that a killed write leaves the old file or the new:
 * a uniquely named temporary file (`<file>.<pid>.<uuid>.tmp`) renamed over it.
 * Under the caller's lock, every other `<file>.*.tmp` beside it — a crashed
 * writer's leftover — is removed first. Fails, writing nothing, when the lock was
 * taken over since it was taken.
 */
export async function writeFileAtomically(file: string, text: string, options: AtomicWriteOptions): Promise<void> {
  await options.lock.assertHeld();
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await removeLeftovers(path.dirname(file), `${path.basename(file)}.`, ".tmp", path.basename(temporary));
  const handle = await fsp.open(temporary, "wx", options.mode);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fsp.rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await options.lock.assertHeld();
    await fsp.rename(temporary, file);
  } catch (error) {
    await fsp.rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Removes every entry of `directory` named `<prefix>…<suffix>` but `keep`. A
 * vanished entry is ignored and, on Windows, one still held open (`EPERM`,
 * `EBUSY`) is left for a later sweep; anything else fails, naming the entry.
 */
export async function removeLeftovers(directory: string, prefix: string, suffix: string, keep?: string): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`cannot list ${directory} to remove leftover ${prefix}*${suffix} files: ${(error as Error).message}`);
  }
  for (const name of names) {
    if (name === keep || !name.startsWith(prefix) || !name.endsWith(suffix) || name.length < prefix.length + suffix.length) continue;
    const leftover = path.join(directory, name);
    try {
      await fsp.rm(leftover, { force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      if (process.platform === "win32" && (code === "EPERM" || code === "EBUSY")) continue;
      throw new Error(`cannot remove leftover ${leftover}: ${(error as Error).message}`);
    }
  }
}
