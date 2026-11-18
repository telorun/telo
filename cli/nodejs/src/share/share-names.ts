import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { userAppDirectory } from "../desktop/desktop-app-directory.js";
import { writeFileAtomically } from "../atomic-file.js";
import { LockFileBusy, takeLockFile, type LockHold } from "../lock-file.js";
import { ShareRefusal } from "./share-refusal.js";

/** The file, in the per-user state directory of `telo`, holding the share name
 *  minted for each real manifest path. */
export const SHARE_NAMES_FILE = "share-names.json";

/** A lock older than this is a crashed run's, and is taken over. */
const LOCK_STALE_MS = 30_000;
/** How long a mint waits for another run's lock before refusing. */
const LOCK_WAIT_MS = 10_000;

/** The name a share of `manifestKey` is taken under: minted once per real path,
 *  so a copy of an application in another directory gets a share of its own
 *  and no home-directory path goes on the wire. Concurrent runs serialize on a
 *  lock file beside the store, so none drops another's entry. */
export async function shareNameFor(manifestKey: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const directory = userAppDirectory("telo", { env });
  if (directory === null) {
    throw new ShareRefusal(
      undefined,
      "this machine has no per-user state directory to keep the share's name in; name the share with --share=<name>",
    );
  }
  const file = path.join(directory, SHARE_NAMES_FILE);
  await fsp.mkdir(directory, { recursive: true });
  const lock = await takeLock(`${file}.lock`);
  try {
    const names = readNames(file);
    const existing = names[manifestKey];
    if (existing !== undefined) return existing;
    const minted = randomUUID();
    try {
      await writeFileAtomically(file, `${JSON.stringify({ ...names, [manifestKey]: minted }, null, 2)}\n`, { lock });
    } catch (error) {
      throw new ShareRefusal(undefined, `cannot write ${file}: ${(error as Error).message}`);
    }
    return minted;
  } finally {
    await lock.release();
  }
}

async function takeLock(lock: string): Promise<LockHold> {
  try {
    return await takeLockFile(lock, { staleMs: LOCK_STALE_MS, waitMs: LOCK_WAIT_MS });
  } catch (error) {
    if (error instanceof LockFileBusy) {
      throw new ShareRefusal(
        undefined,
        `another telo run holds ${lock} and did not release it within ${LOCK_WAIT_MS / 1000} s; delete the file if no other run is starting, or name the share with --share=<name>`,
      );
    }
    throw new ShareRefusal(undefined, (error as Error).message);
  }
}

function readNames(file: string): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ShareRefusal(undefined, `cannot read ${file}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ShareRefusal(undefined, `${file} is not valid JSON (${(error as Error).message}); fix or delete it`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ShareRefusal(undefined, `${file} must hold an object of share names by manifest path; fix or delete it`);
  }
  return parsed as Record<string, string>;
}
