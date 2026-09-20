import * as fs from "node:fs";
import * as path from "node:path";
import { outDocument } from "../output.js";
import { APP_INFO_ENV, appsRoot } from "./app-home.js";
import { CACHE_PREFIX, readPayloadIndex, unpackPayload, type AppIndex } from "./app-payload.js";
import { payloadDigest, readEmbeddedPayload } from "./app-trailer.js";

/**
 * What a packaged application does before it is an application.
 *
 * The payload is unpacked once, keyed by its digest, and the run that follows is
 * `telo run`'s own — there is no second code path, which is what carries the
 * SIGINT/SIGTERM handling and the kernel's exit code into a packaged service.
 *
 * Every argument belongs to the application, so nothing here reads argv. The two
 * questions an operator still has are answered by the environment instead:
 * `TELO_APP_DIR` relocates the unpack root, `TELO_APP_INFO` prints what this
 * binary carries.
 */

/** Written last, so a directory is only reused once it is complete. */
const READY_MARKER = ".telo-app-ready";
/** Holds one file per live process, named by pid — what makes the sweep a
 *  question with an answer rather than an age heuristic. */
const LIVE_DIR = "live";

/**
 * What this executable turned out to be.
 *
 * `info` is its own outcome rather than an exit inside the reader: a payload
 * write is followed by `process.exitCode`, never `process.exit()` — on a pipe
 * the write is asynchronous and `exit` does not flush, so
 * `TELO_APP_INFO=1 ./orders | jq` could read truncated JSON.
 */
export type CarrierContents =
  | { readonly kind: "none" }
  | { readonly kind: "info" }
  | { readonly kind: "app"; readonly app: PackagedApp };

export interface PackagedApp {
  readonly index: AppIndex;
  /** The unpacked tree. */
  readonly dir: string;
  /** The entry manifest inside it. */
  readonly entry: string;
  /** The app's own cache root — the payload, which is the only cache it has. */
  readonly cacheDir: string;
}

/**
 * The application this executable carries, unpacked and ready to run, or
 * `undefined` when this is an ordinary `telo`.
 *
 * The cost on the ordinary CLI's startup path is one 52-byte read of its own
 * file.
 */
export async function loadPackagedApp(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CarrierContents> {
  const payload = await readEmbeddedPayload(execPath);
  if (!payload) return { kind: "none" };

  const index = await readPayloadIndex(payload.bytes);
  const digest = payloadDigest(payload.bytes);
  if (env[APP_INFO_ENV]?.trim()) {
    // A bare document, through the Output seam like every other CLI-owned
    // write: this is the one thing a packaged binary says about itself rather
    // than about its application.
    outDocument({ ...index, payload: `sha256:${digest}` });
    return { kind: "info" };
  }

  const root = appsRoot(env);
  if (!root) {
    throw new Error(
      `${index.app.name} could not find a writable directory to unpack into. ` +
        `It tried the user cache directory and the temporary directory. ` +
        `Set TELO_APP_DIR to a writable path (a mounted volume, under a read-only root filesystem).`,
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
  sweepSiblings(root, index.app.name, dir);

  // The payload IS the cache. It is handed to the run as a value rather than
  // written into `process.env`: the run already takes its entry, its env anchor
  // and its analysis key that way, and a process-global side channel for the
  // fourth would be one concept addressed two ways.
  const cacheDir = path.join(dir, CACHE_PREFIX);
  return { kind: "app", app: { index, dir, entry: path.join(dir, index.entry), cacheDir } };
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
    // place, so the path to remove is resolved at exit rather than captured.
    const drop = (): void => {
      try {
        fs.rmSync(mark, { force: true });
      } catch {
        // A sweep answers for it: the pid is gone either way.
      }
    };
    process.once("exit", drop);
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

/**
 * Run the packaged application through `telo run`'s own implementation.
 *
 * Every argument after the program name is the application's, exactly as
 * `telo run app.yaml -- …` passes them today. The CLI is unreachable from a
 * packaged binary: the user of `./orders` is not a telo user.
 */
export async function runPackagedApp(app: PackagedApp, argv: readonly string[]): Promise<void> {
  const { run } = await import("../commands/run.js");
  await run({
    path: app.entry,
    verbose: false,
    debug: false,
    open: false,
    watch: false,
    cacheWrite: true,
    // The deployment's configuration surface is where the operator stands, not
    // the digest-keyed tree the payload happens to unpack into.
    envAnchor: process.cwd(),
    // An external `TELO_CACHE_DIR` is deliberately not honoured here: it would
    // point the kernel at a tree holding none of this application's modules.
    cacheDir: app.cacheDir,
    analysisKey: app.index.analysisKey,
    "--": [...argv],
  });
}
