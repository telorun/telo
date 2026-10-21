import * as fs from "node:fs";
import * as path from "node:path";
import { APP_DIR_ENV, appsRoot } from "./app-home.js";
import { CACHE_PREFIX, readPayloadIndex, unpackPayload, type AppIndex } from "./app-payload.js";
import { payloadDigest, readEmbeddedPayload } from "./app-trailer.js";

/**
 * A packaged executable's payload, on disk where a command can load it.
 *
 * The payload is unpacked once, keyed by its digest, and every command that is
 * handed the executable — a run, a check, a describe — loads from that one tree.
 * Nothing the payload carries is executed here: it is data, written under a
 * directory this process owns.
 */

/** Written last, so a directory is only reused once it is complete. */
const READY_MARKER = ".telo-app-ready";
/** Holds one file per live process, named by pid — what makes the sweep a
 *  question with an answer rather than an age heuristic. */
const LIVE_DIR = "live";

export interface PackagedApp {
  /** The packaged executable, absolute. */
  readonly executable: string;
  readonly index: AppIndex;
  /** The unpacked tree. */
  readonly dir: string;
  /** The entry manifest inside it. */
  readonly entry: string;
  /** The app's own cache root — the payload, which is the only cache it has. */
  readonly cacheDir: string;
}

export interface UnpackOptions {
  /** Reclaim the application's other unpacked trees. Only a run does: a tree is
   *  reclaimed because a newer build of the app replaced it, and a command that
   *  only reads a binary says nothing about which build is deployed. */
  readonly reclaim: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * The application `executable` carries, unpacked and held by this process, or
 * `undefined` when it carries none.
 */
export async function openPackagedApp(
  executable: string,
  options: UnpackOptions,
): Promise<PackagedApp | undefined> {
  const payload = await readEmbeddedPayload(executable);
  if (!payload) return undefined;

  const index = await readPayloadIndex(payload.bytes);
  const digest = payloadDigest(payload.bytes);
  const root = appsRoot(options.env ?? process.env);
  if (!root) {
    throw new Error(
      `${index.app.name} could not find a writable directory to unpack into. ` +
        `It tried the user cache directory and the temporary directory. ` +
        `Set ${APP_DIR_ENV} to a writable path (a mounted volume, under a read-only root filesystem).`,
    );
  }

  const dir = path.join(root, `${index.app.name}-${digest.slice(0, 16)}`);
  if (fs.existsSync(path.join(dir, READY_MARKER))) {
    holdDirectory(dir);
  } else {
    // The hold is written INSIDE the staging directory, so the tree is held from
    // the moment it becomes visible. Taking it after the rename leaves a window
    // in which another build of the same app, starting concurrently, sees no
    // hold and reclaims a tree this process is about to run from — which is the
    // rolling deploy the sweep exists for.
    await materialize(payload.bytes, dir, digest);
  }
  if (options.reclaim) sweepSiblings(root, index.app.name, dir);

  return {
    executable,
    index,
    dir,
    entry: path.join(dir, index.entry),
    cacheDir: path.join(dir, CACHE_PREFIX),
  };
}

/** Unpack beside the target and rename into place, so two copies starting at
 *  once cannot serve each other a half-written tree. */
async function materialize(payload: Buffer, dir: string, digest: string): Promise<void> {
  const staging = `${dir}.${process.pid}.tmp`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  fs.chmodSync(staging, 0o700);
  await unpackPayload(payload, staging);
  holdDirectory(staging);
  fs.writeFileSync(path.join(staging, READY_MARKER), `${digest}\n`, { mode: 0o600 });
  try {
    fs.renameSync(staging, dir);
    // The mark travelled with the tree; re-holding registers the removal under
    // the path it now lives at, so this process's hold is dropped when it exits
    // rather than left for the next sweep to find as a dead pid.
    holdDirectory(dir);
  } catch (err) {
    // Another copy won the race and has already put an identical tree there —
    // identical because the name is the payload's digest. Hold THAT one instead,
    // then drop the staging copy.
    if (!fs.existsSync(path.join(dir, READY_MARKER))) throw err;
    holdDirectory(dir);
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Every hold this process has taken, dropped together when it exits — one
 *  listener however many times a tree is opened (a watch session reopens its
 *  executable on every reload). */
const heldMarks = new Set<string>();

function dropHolds(): void {
  for (const mark of heldMarks) {
    try {
      fs.rmSync(mark, { force: true });
    } catch {
      // A sweep answers for it: the pid is gone either way.
    }
  }
}

/** Record that this process is using the tree, so another copy's sweep leaves
 *  it alone. Best-effort: a tree that cannot be marked is one that may be
 *  reclaimed early, which costs an extraction, never correctness. */
function holdDirectory(dir: string): void {
  try {
    const live = path.join(dir, LIVE_DIR);
    fs.mkdirSync(live, { recursive: true, mode: 0o700 });
    const mark = path.join(live, String(process.pid));
    fs.writeFileSync(mark, "", { mode: 0o600 });
    // The mark travels with the tree when the staging directory is renamed into
    // place, so the tree is re-held under the path it then lives at and both
    // paths are removed at exit — the staging one by then names nothing.
    if (heldMarks.size === 0) process.once("exit", dropHolds);
    heldMarks.add(mark);
  } catch {
    // No hold; see above.
  }
}

/**
 * Reclaim this application's other unpacked trees.
 *
 * Every build is a new digest, so without this a deployment that ships ten
 * versions leaves ten closures behind and nothing removes them. A tree is
 * reclaimed only when no live process holds it — the runner's pid sweep, which
 * answers the question rather than guessing at an age — and **deletion is always
 * safe**, because a reclaimed tree comes back out of the binary that owns it.
 * So a blue/green pair keeps both trees, and a version merely idle loses only
 * one extraction.
 */
function sweepSiblings(root: string, appName: string, keep: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${appName}-`)) continue;
    const dir = path.join(root, entry.name);
    if (path.resolve(dir) === path.resolve(keep)) continue;
    if (heldByLiveProcess(dir)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Someone else's to own, or in use on a platform that says so.
    }
  }
}

function heldByLiveProcess(dir: string): boolean {
  let pids: string[];
  try {
    pids = fs.readdirSync(path.join(dir, LIVE_DIR));
  } catch {
    return false;
  }
  for (const name of pids) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      // Signal 0 tests for the process without touching it.
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means it exists and belongs to someone else, which still counts.
      if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
      try {
        fs.rmSync(path.join(dir, LIVE_DIR, name), { force: true });
      } catch {
        // A later sweep answers for it.
      }
    }
  }
  return false;
}
