import { RuntimeError } from "@telorun/sdk";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { ControllerEnvMissingError } from "./napi-loader.js";
import { REALM_COLLAPSE_NAMES } from "./realm.js";

/**
 * Build a **local** module's bundled controller from its TypeScript source, so a
 * fresh clone runs `telo run ./manifest.yaml` with no build step.
 *
 * This is the dev half of `pkg:telo/local/js?path=…&local_path=…`: `path=` names
 * the prebuilt `.mjs` that ships in a published artifact, `local_path=` names the
 * source it was built from. When the declaring module is on disk with no artifact
 * behind it, the source is what is authoritative — a stale checked-in bundle
 * would otherwise shadow the edit the author just made.
 *
 * Same shape the kernel already runs twice: `NapiControllerLoader` builds a crate
 * from `local_path`, and `bundle-builder.ts` runs esbuild at load time over an npm
 * controller's dependency tree.
 *
 * ## How the cache is keyed
 *
 * A bundle's inputs are a graph — the module's own `src/**`, the shared TS
 * libraries it inlines, its dependency tree — so a staleness check anchored on
 * the entry point is wrong for the most common edit there is: a sibling file, or
 * a shared library one directory over. The output path is therefore keyed on a
 * signature over **every input esbuild reported**, which turns a changed input
 * into a different key: nothing to invalidate, and nothing to get wrong.
 *
 * It is **stat-addressed, not content-addressed**: the signature is each input's
 * path, size and mtime, because the set spans a whole dependency tree and a few
 * thousand `stat`s cost less than the build they avoid, while hashing every byte
 * would cost more. The trade is worth naming, because it is not free:
 *
 * - a checkout that restores byte-identical files mints a fresh key, so a branch
 *   switch rebuilds rather than hitting the cache;
 * - two different contents with the same size, written inside the same
 *   millisecond, collide — vanishingly unlikely for hand edits, and bounded by
 *   the fact that this path only ever runs against a working copy.
 *
 * Neither costs correctness of what ships: a published artifact never takes this
 * path at all.
 *
 * Keying the output path (rather than overwriting one file) also makes
 * concurrency benign. The test suite spawns one kernel *process* per manifest, so
 * the contention is between processes, where an in-process single-flight gate
 * sees nothing. Two processes that race build identical bytes for identical keys,
 * and each writes through a private temp file before an atomic rename — so a
 * reader sees a whole bundle or no bundle, never a torn one.
 *
 * Superseded bundles are pruned on the build that replaces them, so a long-lived
 * checkout does not accumulate one `.mjs` per save.
 */

/** Cache layout under the kernel's cache root: the built bundles, plus one index
 *  entry per entry point recording the inputs its last build read. */
const CACHE_DIR = "controller-src";

/**
 * The esbuild options a controller bundle is built with. They must match the
 * flags each module's `build` script passes, because a bundle a contributor runs
 * has to be the bundle that ships.
 *
 * The realm names stay external because the bundle loader symlinks them to the
 * kernel's own copy at load time. Inlining them would duplicate the runtime and
 * break the constructor identity `Stream` / `InvokeError` depend on.
 *
 * The banner defines `require` in module scope so esbuild's `__require` shim —
 * emitted for `require(...)` calls inside a bundled CJS dependency — falls
 * through to the real require instead of throwing "Dynamic require of X is not
 * supported", which it would in a `.mjs` where `require` is otherwise undefined.
 */
const CONTROLLER_BUNDLE_OPTIONS = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  // Inline a workspace TS library from its SOURCE, not from its `dist/`.
  //
  // Two reasons, and the first is load-bearing: `dist/` is a build output, so
  // resolving through it would make building a controller depend on having built
  // every library it inlines — which is exactly the build step this path exists
  // to remove, and it fails on a fresh clone with "Could not resolve". The second
  // is that the shipping build passes the same condition, so both inline the same
  // bytes; resolving to `dist` in one and `src` in the other would mean two
  // transpilers producing the bundle a contributor runs versus the one that ships.
  //
  // `source` is the conventional name for this and every inlined package declares
  // it ahead of `import`. A package that does not simply resolves as before.
  conditions: ["source"],
  banner: {
    js:
      'import { createRequire as __teloCreateRequire } from "node:module";' +
      "const require = __teloCreateRequire(import.meta.url);",
  },
  external: [...REALM_COLLAPSE_NAMES],
} as const;

/**
 * Fingerprint of the options above, folded into every cache key.
 *
 * The output is a function of the inputs *and* how they were built, so a change
 * to the option set has to invalidate the cache the same way an edited source
 * does — otherwise a kernel upgrade that changes the banner or the externals
 * keeps serving bundles built the old way, which is the exact silent-stale-copy
 * failure the content-addressing exists to prevent.
 */
const OPTIONS_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify(CONTROLLER_BUNDLE_OPTIONS))
  .digest("hex")
  .slice(0, 8);

interface BuildIndexEntry {
  /** Absolute paths of every file the last build read, from esbuild's metafile. */
  inputs: string[];
  /** Signature of those inputs at build time; the built bundle's cache key. */
  key: string;
}

/** Memoized esbuild handle: `undefined` until first tried, `null` when absent. A
 *  failed dynamic import is not reliably cached by Node, so without this every
 *  controller load re-attempts (and re-fails) the import. */
let esbuildModule: typeof import("esbuild") | null | undefined;
async function loadEsbuild(): Promise<typeof import("esbuild") | null> {
  if (esbuildModule !== undefined) return esbuildModule;
  try {
    esbuildModule = await import("esbuild");
  } catch {
    esbuildModule = null;
  }
  return esbuildModule;
}

/**
 * Whether this host can build a controller from source at all.
 *
 * Asked at *resolve* time, not at build time, so the absence of esbuild selects
 * the prebuilt `path=` file instead of failing the load. esbuild is an
 * **optional** dependency precisely so an install that skips optionals still runs
 * published artifacts — and a working copy that has run its build script has the
 * same prebuilt file sitting there. Deciding this lazily inside the build would
 * turn "no bundler" into a hard failure with a perfectly good bundle on disk.
 */
export async function canBuildFromSource(): Promise<boolean> {
  return (await loadEsbuild()) !== null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Signature of an input set: each file's path, size and mtime, hashed together.
 * Stat rather than content because the set spans a whole dependency tree — a few
 * thousand stats cost less than the build they are avoiding, while reading every
 * byte would cost more.
 *
 * Returns `null` when any recorded input has disappeared, which is itself a
 * change: the caller rebuilds rather than trusting a signature computed over a
 * file set that no longer exists.
 */
async function signInputs(inputs: string[]): Promise<string | null> {
  const stats = await Promise.all(
    inputs.map(async (file) => {
      try {
        const stat = await fs.stat(file);
        return `${file}\0${stat.size}\0${stat.mtimeMs}`;
      } catch {
        return null;
      }
    }),
  );
  if (stats.some((entry) => entry === null)) return null;
  return createHash("sha256")
    .update(OPTIONS_FINGERPRINT)
    .update("\n")
    .update(stats.join("\n"))
    .digest("hex")
    .slice(0, 32);
}

function indexPath(cacheDir: string, entryFile: string): string {
  const id = createHash("sha256").update(entryFile).digest("hex").slice(0, 32);
  return path.join(cacheDir, `${id}.index.json`);
}

function bundlePath(cacheDir: string, key: string): string {
  return path.join(cacheDir, `${key}.mjs`);
}

/**
 * Every file the last build of `entryFile` actually read, from esbuild's own
 * metafile — the module's sources, the shared TS libraries it inlines, and its
 * dependency tree.
 *
 * Exported for watch mode, which needs exactly this set and cannot derive it:
 * the bundle's inputs are a graph, so watching the entry point's directory both
 * misses a shared library one directory over and sweeps in build output. Empty
 * before the first build, when there is nothing to be stale about yet.
 */
export async function lastBuildInputs(
  entryFile: string,
  cacheRoot: string,
): Promise<string[]> {
  const index = await readIndex(indexPath(path.join(cacheRoot, CACHE_DIR), entryFile));
  return index?.inputs ?? [];
}

async function readIndex(file: string): Promise<BuildIndexEntry | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as BuildIndexEntry;
    return Array.isArray(parsed.inputs) && typeof parsed.key === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** In-process single-flight per entry point — the cheap common case, on top of
 *  the cross-process safety the content-addressed path already provides. */
const buildsInFlight = new Map<string, Promise<string>>();
let tmpCounter = 0;

/**
 * Return the path of a current bundle for `entryFile`, building it if the cache
 * has none. Throws `ERR_CONTROLLER_BUILD_FAILED` when the source does not build —
 * that is broken user code and must surface, never fall through to another
 * candidate.
 */
export async function buildControllerFromSource(
  entryFile: string,
  cacheRoot: string,
): Promise<string> {
  const cacheDir = path.join(cacheRoot, CACHE_DIR);
  const index = await readIndex(indexPath(cacheDir, entryFile));
  if (index) {
    const key = await signInputs(index.inputs);
    if (key === index.key) {
      const cached = bundlePath(cacheDir, key);
      if (await pathExists(cached)) return cached;
    }
  }

  const inFlight = buildsInFlight.get(entryFile);
  if (inFlight) return inFlight;
  const work = build(entryFile, cacheDir).finally(() => buildsInFlight.delete(entryFile));
  buildsInFlight.set(entryFile, work);
  return work;
}

async function build(entryFile: string, cacheDir: string): Promise<string> {
  const esbuild = await loadEsbuild();
  if (!esbuild) {
    // Explicit rather than a silent fallthrough: esbuild is an *optional*
    // dependency precisely so a production install that skips optionals still
    // loads published artifacts, which ship prebuilt bundles. Only building a
    // local module from source needs it, and that case has to say so.
    throw new ControllerEnvMissingError(
      `Cannot build controller from source "${entryFile}": esbuild is not installed. ` +
        `Building a local module's controller needs it; a published module ships a ` +
        `prebuilt bundle and does not.`,
    );
  }

  let built: import("esbuild").BuildResult<{ write: false; metafile: true }>;
  try {
    built = await esbuild.build({
      ...CONTROLLER_BUNDLE_OPTIONS,
      // esbuild's options are mutable arrays; the shared constant is `as const`
      // so it cannot be edited in place by one caller and read by another.
      external: [...CONTROLLER_BUNDLE_OPTIONS.external],
      conditions: [...CONTROLLER_BUNDLE_OPTIONS.conditions],
      entryPoints: [entryFile],
      write: false,
      metafile: true,
      logLevel: "silent",
    });
  } catch (err) {
    throw new RuntimeError(
      "ERR_CONTROLLER_BUILD_FAILED",
      `Failed to build controller from source "${entryFile}":\n` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  const output = built.outputFiles?.[0];
  if (!output) {
    throw new RuntimeError(
      "ERR_CONTROLLER_BUILD_FAILED",
      `esbuild produced no output for controller source "${entryFile}"`,
    );
  }

  // Absolute, so the signature is independent of the working directory the next
  // kernel happens to run from.
  const inputs = Object.keys(built.metafile.inputs).map((rel) => path.resolve(rel));
  const key = (await signInputs(inputs)) ?? createHash("sha256")
    .update(output.text)
    .digest("hex")
    .slice(0, 32);
  const target = bundlePath(cacheDir, key);

  await fs.mkdir(cacheDir, { recursive: true });
  const index = indexPath(cacheDir, entryFile);
  const superseded = (await readIndex(index))?.key;
  const tmp = `${target}.${process.pid}.${tmpCounter++}.tmp`;
  await fs.writeFile(tmp, output.text);
  await fs.rename(tmp, target);
  // Index last: a reader that finds it trusts the bundle it names to be on disk.
  // A torn index self-heals — an unparseable one reads as a miss and rebuilds.
  const tmpIndex = `${index}.${process.pid}.${tmpCounter++}.tmp`;
  await fs.writeFile(tmpIndex, JSON.stringify({ inputs, key } satisfies BuildIndexEntry));
  await fs.rename(tmpIndex, index);
  await prune(cacheDir, superseded, key);
  return target;
}

/**
 * Drop the bundle this build replaced.
 *
 * Every save mints a new key, so without this a day of editing leaves one `.mjs`
 * per save and the cache grows for the life of the checkout. Pruned *after* the
 * new index is in place, so a concurrent reader is already being pointed at the
 * replacement; on Linux a process that opened the old file keeps reading it
 * through the open handle, and on Windows a failed unlink is swallowed — a stale
 * file costs disk, never correctness.
 */
async function prune(cacheDir: string, superseded: string | undefined, current: string): Promise<void> {
  if (!superseded || superseded === current) return;
  await fs.rm(bundlePath(cacheDir, superseded), { force: true }).catch(() => {});
}
