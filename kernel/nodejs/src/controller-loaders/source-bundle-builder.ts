import { DEFAULT_MANIFEST_FILENAME, type LibraryCandidate } from "@telorun/analyzer";
import { RuntimeError } from "@telorun/sdk";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
// Type-only, so this builder stays free of a runtime edge to the dispatcher.
import type { ControllerWorkReporter } from "../controller-loader.js";

import { readOwnerManifest } from "../bundle/module-manifest.js";
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
 * A module-owned library this bundle must **not** inline: the bare specifier its
 * sources import it by, and the tree that specifier's code lives in.
 *
 * Both halves are load-bearing. The specifier is what esbuild externalizes; the
 * tree is what the post-build check tests the metafile against, because an import
 * written some other way — a relative path into a sibling's sources, a subpath, a
 * transitive dependency that reaches the same file — would sail past an externals
 * list and silently restore the duplicated module scope this whole mechanism
 * exists to remove.
 *
 * The tree is the directory of the library's **entry source**, not the module's
 * own directory. A module directory holds its tests, and a test fixture module
 * nested inside one is a different module whose bundle is its own; taking the
 * whole directory would report every such fixture as an inlined sibling. What can
 * actually be inlined is what the entry point reaches, which is what it sits in.
 */
export interface SiblingLibrary {
  readonly specifier: string;
  /** Absolute directory of the library's entry source. Absent for a published
   *  sibling, which ships no sources for a consumer's build to reach. */
  readonly sourceDir?: string;
}

/**
 * The esbuild options a controller bundle is built with. They must match the
 * flags each module's `build` script passes, because a bundle a contributor runs
 * has to be the bundle that ships.
 *
 * The realm names stay external because the bundle loader symlinks them to the
 * kernel's own copy at load time. Inlining them would duplicate the runtime and
 * break the constructor identity `Stream` / `InvokeError` depend on. A sibling
 * module's declared specifier is external for the same reason one step out: the
 * loader resolves it to that module's own library layer, so every consumer —
 * and the owning module's own controllers — share one module scope.
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
 * Fingerprint of the options above **and this module's externals**, folded into
 * every cache key.
 *
 * The output is a function of the inputs *and* how they were built, so a change
 * to the option set has to invalidate the cache the same way an edited source
 * does — otherwise a kernel upgrade that changes the banner or the externals
 * keeps serving bundles built the old way, which is the exact silent-stale-copy
 * failure the content-addressing exists to prevent. The externals now vary per
 * module, and they decide whether a library is inlined or resolved at load, so
 * they belong in the key for exactly the same reason the banner does.
 */
function optionsFingerprint(externals: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(CONTROLLER_BUNDLE_OPTIONS))
    .update("\n")
    .update(JSON.stringify([...externals].sort()))
    .digest("hex")
    .slice(0, 8);
}

/** The bare specifiers one build externalizes: the realm names plus every
 *  sibling library, sorted so the fingerprint is order-independent. */
function externalSpecifiers(libraries: readonly SiblingLibrary[]): string[] {
  return [...REALM_COLLAPSE_NAMES, ...libraries.map((l) => l.specifier)];
}

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
async function signInputs(inputs: string[], externals: readonly string[]): Promise<string | null> {
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
    .update(optionsFingerprint(externals))
    .update("\n")
    .update(stats.join("\n"))
    .digest("hex")
    .slice(0, 32);
}

function indexPath(cacheDir: string, entryFile: string): string {
  const id = createHash("sha256").update(entryFile).digest("hex").slice(0, 32);
  return path.join(cacheDir, `${id}.index.json`);
}

/**
 * Each build gets its **own directory**, not just its own filename.
 *
 * The bundle loader writes a `node_modules/` beside a bundle to make bare
 * specifiers resolve — the realm names, and one shim per sibling library. Those
 * are per bundle: two modules can legitimately resolve different versions of one
 * library, and with every dev build sharing one flat cache directory the second
 * would overwrite the first's shim and silently hand it the wrong copy. A
 * directory per content-addressed key makes that unrepresentable, and costs an
 * inode.
 */
function bundleDir(cacheDir: string, key: string): string {
  return path.join(cacheDir, key);
}

function bundlePath(cacheDir: string, key: string): string {
  return path.join(bundleDir(cacheDir, key), "bundle.mjs");
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
  libraries: readonly SiblingLibrary[] = [],
  report?: ControllerWorkReporter,
): Promise<string> {
  const cacheDir = path.join(cacheRoot, CACHE_DIR);
  const externals = externalSpecifiers(libraries);
  const index = await readIndex(indexPath(cacheDir, entryFile));
  if (index) {
    const key = await signInputs(index.inputs, externals);
    if (key === index.key) {
      const cached = bundlePath(cacheDir, key);
      if (await pathExists(cached)) return cached;
    }
  }

  const inFlight = buildsInFlight.get(entryFile);
  if (inFlight) return inFlight;
  // Below the content-addressed cache and the in-flight gate: from here esbuild
  // really runs, which is the only branch worth reporting as a wait.
  await report?.("source-build");
  const work = build(entryFile, cacheDir, libraries).finally(() =>
    buildsInFlight.delete(entryFile),
  );
  buildsInFlight.set(entryFile, work);
  return work;
}

/**
 * The bundle for `entryFile` **and the file set that produced it**.
 *
 * The publish and release paths need both halves of one build: the bytes become
 * the module's controller layer, and the metafile inputs become the release
 * edge graph — which module's source got inlined into whose artifact. Asking for
 * them separately would either build twice or read an index written by a
 * different build.
 *
 * Unlike the loader's path there is **no fallthrough here**. A host without
 * esbuild raises `ControllerEnvMissingError` from the build, and this caller
 * must let it: selecting the prebuilt `path=` file instead would digest and ship
 * bytes other than the source it claims to be built from, which is the one
 * outcome the whole release design exists to prevent.
 */
export async function buildControllerBundle(
  entryFile: string,
  cacheRoot: string,
  libraries: readonly SiblingLibrary[] = [],
): Promise<{ path: string; inputs: string[] }> {
  const path = await buildControllerFromSource(entryFile, cacheRoot, libraries);
  return { path, inputs: await lastBuildInputs(entryFile, cacheRoot) };
}

/**
 * Refuse a **subpath** of an externalized specifier.
 *
 * A module's library surface is one specifier and one entry point — subpaths are
 * deliberately not representable, since reproducing npm's `exports` map inside
 * the artifact would pull a package manager's resolution semantics into Telo. Left
 * alone, `@telorun/ai/content` matches no external, so esbuild inlines it and the
 * duplicated scope comes back silently. Marking `<specifier>/*` external instead
 * would trade that for a module-not-found on someone else's machine, so the
 * honest place to fail is the build.
 */
function rejectSubpathImports(libraries: readonly SiblingLibrary[]): import("esbuild").Plugin {
  return {
    name: "telo-library-subpath",
    setup(build) {
      for (const library of libraries) {
        const prefix = `${library.specifier}/`;
        build.onResolve({ filter: new RegExp(`^${escapeRegExp(prefix)}`) }, (args) => ({
          errors: [
            {
              text:
                `'${args.path}' imports a subpath of the module library '${library.specifier}'. ` +
                `A module exposes one entry point, so import '${library.specifier}' itself.`,
            },
          ],
        }));
      }
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Refuse a bundle that reached into a sibling module's source tree by any route
 * other than its declared specifier.
 *
 * The externals list only governs what the *entry's own* imports resolve to. A
 * relative path into a sibling's `src/`, or a transitive hop through a third
 * package, lands the sibling's source in this bundle regardless — one more copy
 * of a module scope, and nothing else would ever report it. The metafile is the
 * only place this is visible, so it is checked here, on both the load path and
 * the publish path, which share this builder.
 */
function assertNoInlinedSiblings(
  entryFile: string,
  inputs: string[],
  libraries: readonly SiblingLibrary[],
): void {
  assertNoUndeclaredSiblings(entryFile, inputs, libraries);
  const offenders = new Map<string, string[]>();
  for (const input of inputs) {
    for (const library of libraries) {
      if (!library.sourceDir) continue;
      const root = library.sourceDir.endsWith(path.sep)
        ? library.sourceDir
        : library.sourceDir + path.sep;
      if (!input.startsWith(root)) continue;
      const seen = offenders.get(library.specifier) ?? [];
      seen.push(input);
      offenders.set(library.specifier, seen);
    }
  }
  if (offenders.size === 0) return;
  const detail = [...offenders]
    .map(([specifier, files]) => `  ${specifier}: ${files.slice(0, 5).join(", ")}`)
    .join("\n");
  throw new RuntimeError(
    "ERR_CONTROLLER_BUILD_FAILED",
    `Controller bundle "${entryFile}" inlines source from a module it imports:\n${detail}\n` +
      `A module-owned library is resolved at load through the import graph, so its module scope ` +
      `is shared. Import it by its declared specifier instead of reaching into its files.`,
  );
}

/**
 * Refuse a bundle that inlined a module-owned library it never declared an import
 * for.
 *
 * The check above is derived from the `imports:` edges, so it is vacuous exactly
 * where the mistake is made: a module whose TypeScript imports `@telorun/sql`
 * while its manifest never says `Sql: ../sql`. Nothing externalizes the specifier,
 * the package manager resolves it, esbuild inlines it, and the duplicated module
 * scope this whole mechanism removes comes back with nothing to report it. The
 * analyzer cannot see TypeScript sources; the metafile is the only place this is
 * decidable, so it is decided here — on the run path and the publish path alike,
 * since both go through this builder.
 *
 * Detection needs no workspace registry: an input that is neither under this
 * module's own root nor inside a `node_modules` tree belongs to *some* other
 * module, and the nearest enclosing `telo.yaml` says which. A third-party
 * dependency always resolves inside a `node_modules` directory, so the probe skips
 * the overwhelming majority of inputs without a filesystem walk.
 */
function assertNoUndeclaredSiblings(
  entryFile: string,
  inputs: string[],
  libraries: readonly SiblingLibrary[],
): void {
  const declared = new Set(libraries.map((library) => library.specifier));
  const ownRoot = nearestModuleRoot(path.dirname(entryFile));
  const offenders = new Map<string, { root: string; files: string[] }>();

  for (const input of inputs) {
    if (input.includes(`${path.sep}node_modules${path.sep}`)) continue;
    if (ownRoot && isUnder(input, ownRoot)) continue;
    const root = nearestModuleRoot(path.dirname(input));
    if (!root || root === ownRoot) continue;
    for (const candidate of libraryCandidatesOf(root)) {
      // A declared specifier is the other check's business — it reports the same
      // file with the instruction that fits (import it properly, not add it).
      if (declared.has(candidate.specifier) || !candidate.localPath) continue;
      if (!isUnder(input, path.dirname(path.resolve(root, candidate.localPath)))) continue;
      const seen = offenders.get(candidate.specifier) ?? { root, files: [] };
      seen.files.push(input);
      offenders.set(candidate.specifier, seen);
    }
  }
  if (offenders.size === 0) return;

  const detail = [...offenders]
    .map(
      ([specifier, { root, files }]) =>
        `  ${specifier} (${root}): ${files.slice(0, 5).join(", ")}`,
    )
    .join("\n");
  throw new RuntimeError(
    "ERR_CONTROLLER_BUILD_FAILED",
    `Controller bundle "${entryFile}" inlines a module-owned library it does not import:\n` +
      `${detail}\n` +
      `Declare that module in this one's \`imports:\` — the kernel then resolves the specifier ` +
      `to its own entry point at load, so the library is one module scope. Undeclared, it is ` +
      `copied into this bundle and any state it keeps becomes a second copy.`,
  );
}

function isUnder(file: string, dir: string): boolean {
  const root = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return file.startsWith(root);
}

/** Nearest ancestor directory holding a `telo.yaml` — the module a file belongs
 *  to. Memoized per directory: a bundle's inputs cluster into a handful of trees,
 *  and the walk is otherwise repeated per file. */
const moduleRoots = new Map<string, string | undefined>();
function nearestModuleRoot(from: string): string | undefined {
  const cached = moduleRoots.get(from);
  if (cached !== undefined || moduleRoots.has(from)) return cached;
  let dir = from;
  for (;;) {
    if (existsSync(path.join(dir, DEFAULT_MANIFEST_FILENAME))) {
      moduleRoots.set(from, dir);
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      moduleRoots.set(from, undefined);
      return undefined;
    }
    dir = parent;
  }
}

/** The `library:` candidates a module declares, read once per module root. An
 *  unreadable or malformed manifest contributes none: this check exists to report
 *  an inlined library, and the analyzer is what reports a broken manifest. */
const moduleLibraries = new Map<string, LibraryCandidate[]>();
function libraryCandidatesOf(root: string): LibraryCandidate[] {
  const cached = moduleLibraries.get(root);
  if (cached) return cached;
  let candidates: LibraryCandidate[] = [];
  try {
    candidates = readOwnerManifest(
      readFileSync(path.join(root, DEFAULT_MANIFEST_FILENAME), "utf8"),
    ).library;
  } catch {
    candidates = [];
  }
  moduleLibraries.set(root, candidates);
  return candidates;
}

async function build(
  entryFile: string,
  cacheDir: string,
  libraries: readonly SiblingLibrary[],
): Promise<string> {
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

  const externals = externalSpecifiers(libraries);
  let built: import("esbuild").BuildResult<{ write: false; metafile: true }>;
  try {
    built = await esbuild.build({
      ...CONTROLLER_BUNDLE_OPTIONS,
      // esbuild's options are mutable arrays; the shared constant is `as const`
      // so it cannot be edited in place by one caller and read by another.
      external: externals,
      conditions: [...CONTROLLER_BUNDLE_OPTIONS.conditions],
      plugins: [rejectSubpathImports(libraries)],
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
  assertNoInlinedSiblings(entryFile, inputs, libraries);
  const key = (await signInputs(inputs, externals)) ?? createHash("sha256")
    .update(output.text)
    .digest("hex")
    .slice(0, 32);
  const target = bundlePath(cacheDir, key);

  await fs.mkdir(path.dirname(target), { recursive: true });
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
 * Every save mints a new key, so without this a day of editing leaves one bundle
 * directory per save and the cache grows for the life of the checkout. Pruned
 * *after* the new index is in place, so a concurrent reader is already being
 * pointed at the replacement; on Linux a process that opened the old file keeps
 * reading it through the open handle, and on Windows a failed unlink is swallowed
 * — a stale file costs disk, never correctness.
 *
 * The whole directory goes, since it holds the bundle's generated `node_modules/`
 * as well as the bundle.
 */
async function prune(cacheDir: string, superseded: string | undefined, current: string): Promise<void> {
  if (!superseded || superseded === current) return;
  await fs.rm(bundleDir(cacheDir, superseded), { force: true, recursive: true }).catch(() => {});
}
