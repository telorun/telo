import { NOOP_LOGGER, type Logger } from "@telorun/sdk";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

/**
 * The cross-process lock guarding mutation of a shared cache directory.
 *
 * Two consumers hold it for the same reason — several Telo processes (and, in
 * one process, several concurrent resolutions) may decide to populate the same
 * directory at the same moment: `NpmControllerLoader` around its install root,
 * and `ModuleArtifact` around a module's extracted layers. One implementation
 * rather than two, because the reclaim rule below is subtle enough that two
 * copies would drift.
 */

/**
 * A held lock is refreshed (its mtime bumped) every {@link LOCK_HEARTBEAT_MS}
 * by the holder. Staleness is judged purely by mtime age — a lock older than
 * this means the holder stopped heartbeating (crashed, was killed, or its
 * container vanished), so it is safe to reclaim. This deliberately does NOT
 * probe the recorded PID for liveness: PID identity is meaningless across
 * container restarts and PID namespaces (deterministic PID reuse makes an
 * unrelated process look like the dead holder on the same hostname), which is
 * exactly what deadlocked container boots. The `{pid, host}` in the lock body
 * is diagnostics for humans, never a reclaim signal. Must be comfortably
 * larger than the heartbeat interval so a briefly-descheduled holder (GC
 * pause, busy event loop) is not reclaimed out from under itself.
 */
const LOCK_STALE_MS = 30_000;

/** How often the holder refreshes the lock mtime while `fn` runs. Well under
 *  {@link LOCK_STALE_MS} so several heartbeats are missed before a live holder
 *  is ever judged stale. */
const LOCK_HEARTBEAT_MS = 5_000;

/**
 * Total wall-clock cap for waiting on the lock — enough for a slow first
 * populate on a peer process to finish, short enough that a genuinely
 * deadlocked CI job fails loudly rather than hanging for hours. The retry
 * interval trades wakeup latency vs. wasted polls; 500ms is well below the
 * lock holder's typical hold time.
 */
const LOCK_WAIT_MAX_MS = 5 * 60_000;
const LOCK_RETRY_MS = 500;

/** After this long waiting on a lock, emit one line so a slow wait is visible
 *  instead of looking like a silent hang. */
const LOCK_WAIT_NOTICE_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * In-process serialization ahead of the filesystem lock.
 *
 * Without it, N concurrent callers for the same directory all reach the fs lock,
 * N-1 sit in the retry loop, and each crossing {@link LOCK_WAIT_NOTICE_MS}
 * prints the wait notice — a notice whose whole point is "another *process* is
 * populating this", printed when the holder is us. (`telo install` fanning 52
 * controllers out through one `Promise.allSettled` printed 51 of them.)
 *
 * Queuing here means exactly one caller per process reaches the fs lock, so the
 * notice regains its cross-process meaning and the losers do no I/O at all. The
 * fs lock is untouched and still provides the cross-process guarantee.
 */
const localQueues = new Map<string, Promise<unknown>>();

function withLocalQueue<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = localQueues.get(dir) ?? Promise.resolve();
  // Run on both settle paths: one failure must not wedge the queue.
  const run = prev.then(fn, fn);
  // The stored tail never rejects — a failure neither poisons followers nor
  // surfaces as an unhandled rejection on the chain copy.
  const tail = run.then(
    () => {},
    () => {},
  );
  localQueues.set(dir, tail);
  // Drop the entry once nothing further is queued, so a long-lived process that
  // touches many directories doesn't retain a promise per directory forever.
  void tail.then(() => {
    if (localQueues.get(dir) === tail) localQueues.delete(dir);
  });
  return run;
}

/**
 * Acquire the lock for `dir` and run `fn` under it: first the in-process queue
 * above, then the cross-process filesystem lock. `label` names the operation in
 * the wait notice and timeout error (e.g. "controller install", "module layer").
 */
export async function withDirectoryLock<T>(
  dir: string,
  label: string,
  fn: () => Promise<T>,
  log: Logger = NOOP_LOGGER,
): Promise<T> {
  return withLocalQueue(dir, () => withFileLock(dir, label, fn, log));
}

/**
 * Acquire a process-portable lock on `<dir>/.lock` and execute fn while
 * holding it. `fs.open(path, 'wx')` is atomic on POSIX and Windows, so
 * concurrent processes serialize naturally.
 *
 * Liveness is a heartbeat: the holder bumps the lock's mtime every
 * {@link LOCK_HEARTBEAT_MS} while `fn` runs, and a waiter reclaims a lock whose
 * mtime is older than {@link LOCK_STALE_MS} (holder crashed/killed/vanished).
 * mtime age is the *only* reclaim signal — the recorded `{pid, host}` is
 * diagnostics, never probed for liveness, because PID identity is unreliable
 * across container restarts and PID namespaces (the failure that deadlocked
 * container boots). Reclaim is via atomic rename to a unique tombstone so two
 * waiters that both see the lock stale can't both win.
 *
 * The lock guards *writes* into the directory. It does NOT serialize reads of
 * already-populated content — those run lock-free against a stable tree.
 */
async function withFileLock<T>(
  dir: string,
  label: string,
  fn: () => Promise<T>,
  log: Logger,
): Promise<T> {
  const lockPath = path.join(dir, ".lock");

  await fs.mkdir(dir, { recursive: true });

  const lockBody = JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now() });
  let handle: import("fs/promises").FileHandle | null = null;
  const waitedSince = Date.now();
  let noticed = false;
  while (true) {
    try {
      handle = await fs.open(lockPath, "wx");
      await handle.writeFile(lockBody);
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      // Lock exists. Reclaim it only if its heartbeat has gone silent.
      if (await reclaimIfStale(lockPath)) continue;
      const waited = Date.now() - waitedSince;
      if (waited > LOCK_WAIT_MAX_MS) {
        throw new Error(
          `[telo] timed out waiting for ${label} lock at ${lockPath} ` +
            `(held >${LOCK_WAIT_MAX_MS / 60_000} min with a live heartbeat). ` +
            `Inspect the lock file or remove it manually if no other Telo process is running.`,
        );
      }
      if (!noticed && waited > LOCK_WAIT_NOTICE_MS) {
        noticed = true;
        log.info(`waiting for ${label} lock`, { "telo.lock.path": lockPath });
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  // Keep the lock fresh while `fn` runs so a slow-but-live operation is never
  // reclaimed. `unref` so the heartbeat can't by itself keep the process alive.
  const heartbeat = setInterval(() => {
    const now = new Date();
    fs.utimes(lockPath, now, now).catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    // The fd close races nothing important: if it fails, the FD is reaped on
    // process exit. The unlink is the dangerous one — a non-ENOENT failure
    // (permissions, read-only mount) means every subsequent kernel waits
    // LOCK_STALE_MS before reclaiming. Surface it so the cause is visible
    // rather than hiding behind a silent hang.
    await handle!.close().catch(() => {});
    try {
      await fs.rm(lockPath, { force: true });
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        log.warn(`failed to release ${label} lock`, { "telo.lock.path": lockPath }, { error: err });
      }
    }
  }
}

/**
 * If the lock at `lockPath` is stale (mtime older than {@link LOCK_STALE_MS}, so
 * its holder stopped heartbeating), atomically claim and remove it and return
 * true; otherwise return false. The claim is a `rename` to a unique tombstone:
 * `rename` is atomic and fails for all but one racer, so two processes that
 * both observe the same stale lock cannot both reclaim it — the loser's rename
 * throws ENOENT (the file is already gone) and it simply retries the open.
 */
async function reclaimIfStale(lockPath: string): Promise<boolean> {
  let stat: import("fs").Stats;
  try {
    stat = await fs.stat(lockPath);
  } catch (err: any) {
    // Race: lock vanished while we inspected it. Retry the open immediately.
    if (err?.code === "ENOENT") return true;
    throw err;
  }
  if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return false;

  // Stale — the holder's heartbeat is silent. Claim via atomic rename; only one
  // racer wins, the rest get ENOENT and fall back to retrying the open.
  const tombstone = `${lockPath}.stale.${process.pid}.${stat.mtimeMs}`;
  try {
    await fs.rename(lockPath, tombstone);
  } catch (err: any) {
    if (err?.code === "ENOENT") return true; // another waiter reclaimed it first
    throw err;
  }
  await fs.rm(tombstone, { force: true });
  return true;
}

/**
 * Internals exposed for the lock's own tests (acquire/release, stale reclaim,
 * heartbeat, in-process queuing). Not part of the kernel's public API.
 */
export const __testing__ = {
  reclaimIfStale,
  LOCK_STALE_MS,
  LOCK_HEARTBEAT_MS,
};
