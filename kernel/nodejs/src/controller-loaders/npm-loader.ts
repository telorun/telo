import { ControllerInstance } from "@telorun/sdk";
import { execFile } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import { createRequire } from "module";
import * as os from "os";
import { PackageURL } from "packageurl-js";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { promisify } from "util";
import { ControllerEnvMissingError } from "./napi-loader.js";

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

/**
 * Package-manager binary used for `<root>/.telo/npm/` installs. Captured once
 * at module load so a mid-process env mutation can't change which binary
 * runs for half an install batch — the kernel's controller installs are
 * sequenced, but predictability beats late-binding here. Override via
 * `TELO_PKG_MANAGER` (e.g. `pnpm`, `bun`).
 */
const PACKAGE_MANAGER = process.env.TELO_PKG_MANAGER ?? "npm";

/**
 * Maximum age before a held lock is considered abandoned. `npm install` on a
 * cold cache for a tree with one or two controllers is comfortably under a
 * minute on modern hardware; tuning higher would let zombie locks persist.
 */
const LOCK_STALE_MS = 60_000;

/**
 * Total wall-clock cap for waiting on the install lock — enough for a slow
 * first install on a peer process to finish, short enough that a deadlocked
 * CI job fails loudly rather than hanging for hours. The retry interval
 * trades wakeup latency vs. wasted polls; 500ms is well below the lock
 * holder's typical hold time.
 */
const LOCK_WAIT_MAX_MS = 5 * 60_000;
const LOCK_RETRY_MS = 500;

/**
 * Tells the dispatcher (and any UI consumer downstream) which branch the
 * resolver actually took. `npm-install` is the only one that hits the network;
 * the rest are sub-second cache/local lookups, so the CLI uses this to decide
 * whether a "downloading…" line was honest or should be silently dropped.
 */
export type NpmResolveSource = "local" | "node_modules" | "npm-install" | "cache";

/**
 * Discriminated representation of how a PURL resolved into an install spec.
 * `kind: "local"` is what the loader synthesizes when a PURL carries a
 * `local_path` qualifier that exists on disk; `kind: "registry"` is the
 * fallback (registry tag, or `local_path` that didn't resolve). The kind
 * threads into `installPackage` so it can pick the right `NpmResolveSource`
 * itself — no caller-side override after the fact.
 */
type ResolvedInstallSpec =
  | { kind: "local"; spec: string; absolutePath: string }
  | { kind: "registry"; spec: string };

/**
 * Just the kind, used as the `installPackage` parameter — both branches
 * already carry the spec separately at the call site.
 */
type SpecKind = ResolvedInstallSpec["kind"];

export interface NpmLoadResult {
  instance: ControllerInstance;
  source: NpmResolveSource;
}

export interface NpmControllerLoaderOptions {
  /**
   * URL of the entry manifest. The install root is anchored here so every
   * controller in this kernel process resolves through one `node_modules`
   * tree. Required at construction time when the kernel is the caller; the
   * `pkg-name` cli command resolves it from its argument.
   */
  entryUrl?: string;
}

/**
 * The npm-loader maintains a single install root per kernel process at
 * `<entry-manifest-dir>/.telo/npm/`. Every controller — registry tag or
 * `local_path` — is installed via `npm install <spec>` into this root, then
 * imported from `<root>/node_modules/<pkg>`. This collapses two parallel
 * module realms (kernel-side @telorun/sdk vs. controller-side @telorun/sdk)
 * into one: the kernel's own SDK is wired in as a `file:` dep, npm/pnpm
 * symlink it, and Node's ESM resolver follows the symlink to the same
 * realpath as the kernel — so `Stream` (and any other class-identity-sensitive
 * type) has a single constructor across the process.
 *
 * Per-kernel state lives on each `NpmControllerLoader` instance (one is
 * constructed per `ControllerLoader`, which is itself constructed per
 * `Telo.Definition.init`). The instance caches the install-root materialization
 * promise (`rootReady`), the set of installed specs (`installedSpecs`), an
 * in-flight install map for single-flight dedupe (`inFlight`), and a snapshot
 * of the install root's `dependencies` map (`rootDeps`) so per-controller
 * fast paths can hit without re-reading `package.json`. Cross-kernel and
 * cross-process safety is provided by a filesystem lock on `<root>/.lock`.
 */
export class NpmControllerLoader {
  private readonly entryUrl?: string;

  /**
   * Per-process cache of "this controller's package + version is already
   * installed in the root and matches our spec" so concurrent loads of the
   * same definition skip the lock + re-check round-trip after the first
   * caller wins. Keyed by absolute spec (e.g. `@telorun/sdk@file:/abs/path`
   * or `@scope/pkg@^1.2.3`).
   */
  private readonly installedSpecs = new Set<string>();

  /**
   * In-flight installs keyed by canonical spec. Two callers racing for the
   * same spec share one `npm install <spec>` invocation rather than each
   * acquiring the fs-lock and reinstalling.
   */
  private readonly inFlight = new Map<string, Promise<void>>();

  /**
   * Promise that resolves when the install root has been materialized
   * (package.json written, kernel-side runtime deps wired up, base
   * `npm install` completed). Subsequent loads await this once.
   */
  private rootReady?: Promise<string>;

  /**
   * Snapshot of the install root's `dependencies` map at the time of last
   * read. Set during `materializeInstallRoot()` and refreshed when an
   * install adds a new spec. Lets the per-controller fast path decide on
   * "already installed?" without re-reading and re-parsing `package.json`
   * for every load — a single test typically touches 5–10 controllers,
   * and a test suite spawns one Kernel per fixture, so the multiplier is
   * `tests * controllers` file reads otherwise.
   */
  private rootDeps: Record<string, string> = {};

  constructor(options: NpmControllerLoaderOptions = {}) {
    this.entryUrl = options.entryUrl;
  }

  async load(purl: string, baseUri: string): Promise<NpmLoadResult> {
    const parsed = PackageURL.fromString(purl);
    if (!parsed.name) {
      throw new Error(`Invalid PURL '${purl}': missing package name`);
    }
    const packageName = parsed.namespace ? `${parsed.namespace}/${parsed.name}` : parsed.name;

    const installRoot = await this.ensureInstallRoot();
    const resolved = await resolveInstallSpec(parsed, packageName, baseUri);
    const source = await this.installPackage(
      installRoot,
      packageName,
      resolved.spec,
      resolved.kind,
      parsed.version ?? null,
    );
    const instance = await loadFromInstall(installRoot, packageName, parsed.subpath ?? null, purl);
    return { instance, source };
  }

  /**
   * Compute the install root from the entry URL, write a baseline package.json
   * pinning the kernel's own runtime deps as `file:` references, run a single
   * `npm install` once, and return the absolute root path. Memoized for the
   * lifetime of this loader instance.
   */
  private ensureInstallRoot(): Promise<string> {
    if (this.rootReady) return this.rootReady;
    this.rootReady = this.materializeInstallRoot().catch((err) => {
      // Reset on failure so a follow-up call retries rather than caches the rejection.
      this.rootReady = undefined;
      throw err;
    });
    return this.rootReady;
  }

  private async materializeInstallRoot(): Promise<string> {
    if (!this.entryUrl) {
      // Throw the env-missing variant so a mixed candidate list (e.g.
      // `pkg:npm/... + pkg:cargo/...`) still falls back to the next
      // candidate. A plain Error would abort the whole resolve chain;
      // callers that intentionally drive the napi loader without supplying
      // an entry URL would otherwise see a hard failure.
      throw new ControllerEnvMissingError(
        "NpmControllerLoader requires an entryUrl. Pass one to the constructor (kernel: " +
          "Kernel.load() records this; CLI: pass the manifest path).",
      );
    }
    const entryUrlStr = this.entryUrl;
    // The install root is anchored next to the entry manifest on disk. For an
    // http(s):// entry URL there is no such anchor — `path.resolve` would
    // silently turn `http://host/x.yaml` into something like
    // `<cwd>/http:/host/x.yaml`, materializing a `.telo/npm` tree in an
    // unrelated directory. Reject the case loudly until we ship an explicit
    // strategy (e.g. a hash-keyed cache under `~/.cache/telo`) for HTTP-sourced
    // manifests; today nothing in the workspace exercises this path.
    const entryPath = parseFileUrlOrThrow(entryUrlStr);
    const entryDir = path.dirname(path.resolve(entryPath));
    const installRoot = path.join(entryDir, ".telo", "npm");

    // Build the install-root package.json: kernel-runtime deps as `file:` refs
    // pointing at the kernel-side realpath. Modules declare these names as
    // `peerDependencies`, so npm/pnpm resolve each controller's `import` to the
    // single copy provided here — the realm-collapse mechanism that gives
    // class-identity-sensitive types (today: `Stream`) one constructor across
    // the kernel/controller boundary.
    const dependencies: Record<string, string> = {};
    for (const name of REALM_COLLAPSE_NAMES) {
      const resolvedPkgRoot = await resolveKernelPackageRoot(name);
      if (!resolvedPkgRoot) {
        // A kernel runtime dep that can't be resolved at boot is unusual but
        // not fatal — the realm-collapse story degrades to "rely on whatever
        // the package manager picks" for that name. Don't crash the loader.
        continue;
      }
      dependencies[name] = `file:${resolvedPkgRoot}`;
    }

    const packageJson = {
      name: "telo-runtime-install",
      private: true,
      version: "0.0.0",
      dependencies,
    };
    const packageJsonPath = path.join(installRoot, "package.json");
    const stateFile = path.join(installRoot, ".telo-state.json");
    const newHash = sha256(JSON.stringify(packageJson));

    await fs.mkdir(installRoot, { recursive: true });

    // Lock-free fast path: if the on-disk state matches what we'd write,
    // there's nothing to install and nothing to serialize. Every fresh
    // Kernel re-enters this code path (e.g. test suites that spawn one
    // Kernel per test), so paying even an `fs.open(.lock, 'wx')` here per
    // test is measurable. Reads-only checks are safe without the lock —
    // the writer side updates package.json + .telo-state.json + node_modules
    // under a held lock, so any read that observes a matching hash plus
    // an existing node_modules has observed a fully materialized tree.
    if (
      (await readJsonField(stateFile, "rootHash")) === newHash &&
      (await pathExists(path.join(installRoot, "node_modules")))
    ) {
      // Lock-free fast path: nothing to do beyond seeding the in-process caches.
      await this.seedDepCaches(installRoot, dependencies);
      return installRoot;
    }

    await withInstallLock(installRoot, async () => {
      // Re-check inside the lock: a peer may have completed the install
      // between the fast-path miss and our acquisition.
      const existingHash = await readJsonField(stateFile, "rootHash");
      if (existingHash === newHash && (await pathExists(path.join(installRoot, "node_modules")))) {
        return;
      }

      await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");
      await runPackageManager(installRoot, ["install", "--no-audit", "--no-fund", "--silent"]);
      await fs.writeFile(stateFile, JSON.stringify({ rootHash: newHash }, null, 2) + "\n");
    });

    await this.seedDepCaches(installRoot, dependencies);
    return installRoot;
  }

  /**
   * Populate the in-process caches that drive the per-controller fast path:
   * `installedSpecs` (so duplicate calls from the same Kernel return immediately)
   * and `rootDeps` (so the fast path doesn't re-read `package.json` per load).
   * `dependencies` is the freshly-built map we know is on disk; it's used as a
   * fallback when the actual file-read fails (e.g. immediately after a hot
   * reload where the writer is still racing).
   */
  private async seedDepCaches(
    installRoot: string,
    dependencies: Record<string, string>,
  ): Promise<void> {
    for (const [name, spec] of Object.entries(dependencies)) {
      this.installedSpecs.add(`${name}@${spec}`);
    }
    this.rootDeps = (await readPackageDeps(installRoot)) ?? { ...dependencies };
  }

  /**
   * Install one controller spec into the existing root. Single-flight per
   * spec within the process; cross-process safety is the fs-lock around the
   * `npm install` call. If the spec is already present in the manifest's
   * package.json (under `dependencies`), skip — reusing the previous install.
   *
   * `kind` distinguishes a `local_path` source (loader synthesized `file:`
   * spec) from a registry tag. The CLI silences progress for both `cache`
   * and `local`; `npm-install` is the only event surfaced. Folding this
   * decision in here means the caller no longer needs to override the
   * returned source after the fact.
   */
  private async installPackage(
    installRoot: string,
    packageName: string,
    spec: string,
    kind: SpecKind,
    requestedVersion: string | null,
  ): Promise<NpmResolveSource> {
    const cacheKey = `${packageName}@${spec}`;
    if (this.installedSpecs.has(cacheKey)) return "cache";

    const inFlight = this.inFlight.get(cacheKey);
    if (inFlight) {
      await inFlight;
      return "cache";
    }

    const targetPath = path.join(installRoot, "node_modules", ...packageName.split("/"));

    // Registry fast path: compare against the installed package's own
    // `package.json` version field. `rootDeps[packageName]` can't be used
    // here because npm rewrites registry specs on `--save` — we pass
    // `@scope/pkg@0.3.4`, npm writes `^0.3.4` — so a string comparison
    // never matches and every fresh `NpmControllerLoader` (one per
    // `Telo.Definition.init`) would fall through to a no-op but ~200ms
    // `npm install`. Reading the installed package.json sidesteps that
    // entirely: if the requested PURL version equals what's on disk, we
    // already have the right thing.
    //
    // Ranges (`^1.0.0`, `~2.3.0`) fall through to a real `npm install` —
    // they're rare in PURLs (which typically pin) and a proper range check
    // would need a semver dep here.
    if (kind === "registry") {
      const installedVersion = await readInstalledVersion(targetPath);
      if (
        installedVersion !== null &&
        (requestedVersion === null || requestedVersion === installedVersion)
      ) {
        this.installedSpecs.add(cacheKey);
        return "cache";
      }
    }

    // Local (`file:`) spec fast path: consult the in-process snapshot of the
    // install root's `dependencies` map (seeded by `materializeInstallRoot`).
    // Normalize because npm rewrites absolute `file:` deps to relative paths
    // inside the install root's `package.json` — the loader passes the
    // absolute path, the on-disk record is `file:../../foo`.
    const cachedSpec = this.rootDeps[packageName];
    if (
      cachedSpec !== undefined &&
      normalizeFileSpec(cachedSpec, installRoot) === normalizeFileSpec(spec, installRoot) &&
      (await pathExists(targetPath))
    ) {
      this.installedSpecs.add(cacheKey);
      return "cache";
    }

    const work = (async () => {
      await withInstallLock(installRoot, async () => {
        // Re-check inside the lock: a peer process may have installed the
        // spec between the fast-path miss and our acquisition. Normalize
        // the on-disk record to absolute form before comparing — npm
        // rewrites `file:` deps to be relative to the install root.
        const lockedSpec = await readDepSpec(installRoot, packageName);
        if (
          lockedSpec !== undefined &&
          normalizeFileSpec(lockedSpec, installRoot) === normalizeFileSpec(spec, installRoot) &&
          (await pathExists(targetPath))
        ) {
          this.rootDeps[packageName] = lockedSpec;
          return;
        }

        await runPackageManager(installRoot, [
          "install",
          "--no-audit",
          "--no-fund",
          "--silent",
          "--save",
          spec,
        ]);
        // Re-read what npm actually wrote (it normalizes `file:` paths to
        // be relative to the install root). Caching the spec in its on-disk
        // form keeps subsequent fast-path comparisons stable.
        const written = await readDepSpec(installRoot, packageName);
        if (written !== undefined) this.rootDeps[packageName] = written;
        else this.rootDeps[packageName] = spec;
      });
    })();

    this.inFlight.set(cacheKey, work);
    try {
      await work;
    } finally {
      this.inFlight.delete(cacheKey);
    }
    this.installedSpecs.add(cacheKey);
    // First-touch local installs report `local` (silenced in CLI progress);
    // fresh registry installs report `npm-install` (the only branch a
    // user-facing "downloading…" line should ever surface for).
    return kind === "local" ? "local" : "npm-install";
  }
}

/**
 * Names of packages whose realpath must be shared between the kernel and every
 * loaded controller. Each name here becomes a `file:` dep in the install-root
 * `package.json`, pinned at the kernel's own resolution; controllers declare
 * these names as `peerDependencies` so npm/pnpm resolves them to that single
 * copy instead of nesting their own.
 *
 * Add a name here if you ship another shared runtime symbol whose `instanceof`
 * or constructor identity matters across module boundaries. Today the only
 * such name is `@telorun/sdk` (carries the `Stream` class registered with
 * `@marcbachmann/cel-js`).
 */
const REALM_COLLAPSE_NAMES: ReadonlyArray<string> = ["@telorun/sdk"];

/**
 * Resolve a kernel-runtime dep name to the realpath of its package directory.
 * Anchored on this module so resolution mirrors the kernel's own.
 *
 * Uses two strategies because well-encapsulated packages (e.g. `@telorun/sdk`)
 * declare a strict `exports` map that doesn't expose `./package.json`:
 *   1. Try `require.resolve("<name>/package.json")` directly — works for
 *      packages without an exports map or with a permissive one.
 *   2. Fall back to resolving the package's main entry and walking up to
 *      the nearest `package.json` whose `name` field matches.
 *
 * Returns null when neither strategy locates the package — `require.resolve`
 * itself throws `MODULE_NOT_FOUND` if the package isn't installed at all,
 * which we treat as "no realm-collapse for this name." Other errors (e.g. a
 * corrupt package.json) propagate so the caller can surface the real cause.
 */
async function resolveKernelPackageRoot(name: string): Promise<string | null> {
  try {
    const pkgJsonPath = requireFromHere.resolve(`${name}/package.json`);
    return path.dirname(pkgJsonPath);
  } catch (err: any) {
    if (err?.code !== "MODULE_NOT_FOUND" && err?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      throw err;
    }
    // exports map withholds package.json — fall through to mainEntry strategy.
  }
  let mainEntry: string;
  try {
    mainEntry = requireFromHere.resolve(name);
  } catch (err: any) {
    if (err?.code === "MODULE_NOT_FOUND") return null;
    throw err;
  }
  let dir = path.dirname(mainEntry);
  while (true) {
    const pkgJsonPath = path.join(dir, "package.json");
    if (await pathExists(pkgJsonPath)) {
      // Confirm the package.json's `name` field matches — we may have walked
      // past the target into a parent's package.json. A malformed package.json
      // here is a real bug (a corrupted node_modules) so let it propagate.
      const pkg = JSON.parse(await fs.readFile(pkgJsonPath, "utf8"));
      if (pkg?.name === name) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Acquire a process-portable lock on `<root>/.lock` and execute fn while
 * holding it. Implementation: `fs.open(path, 'wx')` is atomic on POSIX and
 * Windows; concurrent processes serialize naturally. PID + start time live
 * inside the lock file so a crashed-holder lock can be detected and reclaimed.
 *
 * The lock guards the install-root manifest write, the package-manager
 * invocation, and any state-file writes. It does NOT serialize *reads* of
 * already-installed controllers — those run lock-free against a stable tree.
 */
async function withInstallLock<T>(installRoot: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(installRoot, ".lock");

  await fs.mkdir(installRoot, { recursive: true });

  const lockBody = JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now() });
  let handle: import("fs/promises").FileHandle | null = null;
  const waitedSince = Date.now();
  while (true) {
    try {
      handle = await fs.open(lockPath, "wx");
      await handle.writeFile(lockBody);
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      // Lock exists. Inspect its mtime + PID. If older than LOCK_STALE_MS and
      // the holding PID isn't alive (or is on another host), reclaim.
      if (await isLockStale(lockPath)) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() - waitedSince > LOCK_WAIT_MAX_MS) {
        throw new Error(
          `[telo] timed out waiting for install lock at ${lockPath} ` +
            `(held >${LOCK_WAIT_MAX_MS / 60_000} min). ` +
            `Inspect the lock file or remove it manually if no other Telo process is running.`,
        );
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    // The fd close races nothing important: if it fails, the FD is reaped on
    // process exit. The unlink is the dangerous one — a non-ENOENT failure
    // (permissions, read-only mount) means every subsequent kernel waits
    // LOCK_STALE_MS before reclaiming. Surface it so the cause is visible
    // rather than hiding behind a silent five-minute hang.
    await handle!.close().catch(() => {});
    try {
      await fs.rm(lockPath, { force: true });
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        process.stderr.write(
          `[telo] failed to release install lock at ${lockPath}: ${err?.message ?? err}\n`,
        );
      }
    }
  }
}

async function isLockStale(lockPath: string): Promise<boolean> {
  let stat: import("fs").Stats;
  try {
    stat = await fs.stat(lockPath);
  } catch (err: any) {
    // Race: lock vanished while we inspected it. The next open() will succeed.
    if (err?.code === "ENOENT") return false;
    throw err;
  }
  const age = Date.now() - stat.mtimeMs;
  if (age < LOCK_STALE_MS) return false;

  let body: string;
  try {
    body = await fs.readFile(lockPath, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
  // A zero-byte or unparseable lock file is interpreted as stale: a previous
  // holder crashed mid-write (empty body) or got partially flushed (truncated
  // JSON). Treating either as held would deadlock; throwing here would block
  // every controller load behind a broken file the operator may not even
  // notice exists.
  if (!body) return true;
  let parsed: { pid?: number; host?: string };
  try {
    parsed = JSON.parse(body);
  } catch {
    return true;
  }
  if (!parsed?.pid) return true;
  if (parsed.host && parsed.host !== os.hostname()) return false; // different host: assume held
  try {
    // signal 0 throws if the PID isn't alive (or is owned by a different user)
    process.kill(parsed.pid, 0);
    return false;
  } catch (err: any) {
    // ESRCH = no such process. EPERM = exists but we can't signal it; treat as alive.
    return err?.code === "ESRCH";
  }
}

async function runPackageManager(cwd: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(PACKAGE_MANAGER, args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  } catch (err: any) {
    const isMissing =
      err?.code === "ENOENT" ||
      /not found|command not recognized/i.test(err?.message ?? "");
    if (isMissing) {
      throw new Error(
        `[telo] '${PACKAGE_MANAGER}' not found on PATH. Telo's controller installer requires a ` +
          `JavaScript package manager (npm or pnpm). Install Node.js (which bundles npm) or set ` +
          `TELO_PKG_MANAGER to a different binary name.`,
      );
    }
    const stderr = err?.stderr ? `\n${err.stderr}` : "";
    throw new Error(
      `[telo] '${PACKAGE_MANAGER} ${args.join(" ")}' failed in ${cwd}:${stderr}`,
    );
  }
}

async function readJsonField(filePath: string, field: string): Promise<unknown> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(text);
    return parsed?.[field];
  } catch {
    return undefined;
  }
}

/**
 * Read the `version` field from `<packageRoot>/package.json`, or null if the
 * file is missing/unreadable/malformed or carries a non-string version. Used
 * by the registry fast path to decide whether an existing install already
 * satisfies the requested PURL version — the install-root's own
 * `dependencies` map can't answer that because npm rewrites registry specs
 * on `--save`.
 */
async function readInstalledVersion(packageRoot: string): Promise<string | null> {
  try {
    const text = await fs.readFile(path.join(packageRoot, "package.json"), "utf8");
    const pkg = JSON.parse(text);
    return typeof pkg?.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Read the install root's `dependencies[<packageName>]` value, or undefined
 * if package.json is missing/unreadable or the dep isn't listed. Used by the
 * lock-free fast path to decide whether a controller is already wired in.
 */
async function readDepSpec(installRoot: string, packageName: string): Promise<string | undefined> {
  try {
    const text = await fs.readFile(path.join(installRoot, "package.json"), "utf8");
    const pkg = JSON.parse(text);
    const value = pkg?.dependencies?.[packageName];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Convert an entry-manifest URL to its on-disk path, throwing a descriptive
 * error for any URL scheme that doesn't map to a local filesystem location.
 * The install-root anchoring story requires a real directory next to the
 * manifest; non-file schemes (e.g. `http://`, `https://`) have no such
 * anchor and would otherwise silently produce a junk path via
 * `path.resolve("http://host/x")`.
 *
 * Bare paths without a scheme are accepted as-is — callers that hand the
 * loader an absolute filesystem path are common and there's no ambiguity
 * to surface.
 */
function parseFileUrlOrThrow(entryUrl: string): string {
  if (entryUrl.startsWith("file://")) return fileURLToPath(entryUrl);
  // A scheme is anything before the first `://` — distinguish a URL from a
  // bare filesystem path (which has no `://`).
  const schemeMatch = entryUrl.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (schemeMatch) {
    // Env-missing rather than a hard error: the dispatcher should advance
    // to the next candidate when an HTTP-sourced manifest is paired with a
    // `pkg:cargo` (or other non-npm) fallback. Hard-failing would lock the
    // whole resolve chain to this branch.
    throw new ControllerEnvMissingError(
      `[telo] entry URL scheme '${schemeMatch[1]}' is not supported by the npm controller ` +
        `loader. The install root must live next to a local manifest; HTTP-sourced manifests ` +
        `have no such anchor. Resolve the manifest to disk first, or use file:// directly. ` +
        `(entryUrl: ${entryUrl})`,
    );
  }
  return entryUrl;
}

/**
 * Normalize a `file:` spec to an absolute path so two specs that point at the
 * same source — one absolute (what the loader synthesizes from `local_path`)
 * and one relative (what npm rewrites into the install root's package.json) —
 * compare equal. Specs that aren't `file:` deps pass through unchanged, since
 * registry tags compare exactly.
 */
function normalizeFileSpec(spec: string, installRoot: string): string {
  if (!spec.startsWith("file:")) return spec;
  const filePath = spec.slice("file:".length);
  if (path.isAbsolute(filePath)) return `file:${path.resolve(filePath)}`;
  return `file:${path.resolve(installRoot, filePath)}`;
}

/**
 * Snapshot the install root's full `dependencies` map so the per-controller
 * fast path can lookup specs without re-reading package.json on every load.
 * Returns null when the file is missing or unreadable; callers decide whether
 * to seed from a synthesized map instead.
 */
async function readPackageDeps(installRoot: string): Promise<Record<string, string> | null> {
  try {
    const text = await fs.readFile(path.join(installRoot, "package.json"), "utf8");
    const pkg = JSON.parse(text);
    const deps = pkg?.dependencies;
    if (!deps || typeof deps !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(deps)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decide what `npm install <spec>` should look like for this PURL. Returns
 * a discriminated union so the caller and the installer agree on the kind
 * of install without re-deriving it from the spec string. `local_path`
 * resolves relative to the *declaring library's* baseUri (each
 * Telo.Definition's manifest URL); the loader installs the absolute path
 * via `npm install file:<abs>` so realm-collapse still applies even for
 * source already on disk.
 */
async function resolveInstallSpec(
  parsed: PackageURL,
  packageName: string,
  baseUri: string,
): Promise<ResolvedInstallSpec> {
  const localPath = parsed.qualifiers?.local_path;
  const isLocalManifest =
    !!baseUri && !baseUri.startsWith("http://") && !baseUri.startsWith("https://");
  if (localPath && isLocalManifest) {
    const baseUriPath = baseUri.startsWith("file://") ? fileURLToPath(baseUri) : baseUri;
    const absolutePath = path.resolve(path.dirname(baseUriPath), localPath);
    if (await pathExists(absolutePath)) {
      return { kind: "local", spec: `file:${absolutePath}`, absolutePath };
    }
  }
  const spec = parsed.version ? `${packageName}@${parsed.version}` : packageName;
  return { kind: "registry", spec };
}

/**
 * Import the controller module out of the install root and validate its
 * shape. Splits cleanly from the install logic so each phase has one job:
 * `installPackage` decides whether work is needed, this function is pure
 * resolve-and-import once the tree is in place.
 */
async function loadFromInstall(
  installRoot: string,
  packageName: string,
  subpath: string | null,
  purl: string,
): Promise<ControllerInstance> {
  const packageRoot = path.join(installRoot, "node_modules", ...packageName.split("/"));
  const entry = subpath ? `./${subpath}` : ".";
  const entryFile = await resolvePackageEntry(packageRoot, entry);
  // ESM dynamic `import()` accepts either a relative specifier or a `file://`
  // URL — but NOT a bare absolute filesystem path. On POSIX the `/abs/path`
  // form works by happy accident; on Windows `C:\path\to\file.js` is rejected
  // outright. Convert through `pathToFileURL` so the loader behaves the same
  // on both platforms.
  //
  // Dynamic `import()` always resolves to a module namespace object on
  // success; it never returns null/undefined. The only meaningful contract
  // check is whether the module exports at least one of the controller hooks.
  const instance = await import(pathToFileURL(entryFile).href);
  if (!instance.create && !instance.register) {
    throw new Error(
      `Invalid controller loaded from "${purl}": exports neither create() nor register()`,
    );
  }
  return instance;
}

/**
 * Default ESM resolver conditions, in priority order. The `bun` condition
 * comes first when running under Bun so dev workspaces resolve to `src/*.ts`
 * directly without a build step. The remaining conditions are the standard
 * Node.js ESM keys; the loader doesn't honour `node` because we always
 * fall back to `import`/`default` for Node anyway.
 */
const DEFAULT_RESOLVER_CONDITIONS: ReadonlyArray<string> =
  typeof (globalThis as any).Bun !== "undefined"
    ? ["bun", "import", "default", "require"]
    : ["import", "default", "require"];

/**
 * Cap on `exports` map traversal depth. A pathological consumer-authored
 * package.json with cycles through array/object trees would otherwise loop
 * forever (the data is third-party — `package.json` files we read out of an
 * arbitrary npm install). 16 levels is far past any plausible legitimate map.
 */
const EXPORTS_MAX_DEPTH = 16;

/**
 * Resolve a package's entry file using its package.json `exports` map first,
 * then the `module`/`main` fields, then a direct path lookup. The conditions
 * list is supplied by the caller so the resolver stays generic — today the
 * only branch is Bun-vs-Node, but worker/browser/electron/deno selections
 * compose the same way.
 */
async function resolvePackageEntry(
  packageRoot: string,
  entry: string,
  conditions: ReadonlyArray<string> = DEFAULT_RESOLVER_CONDITIONS,
): Promise<string> {
  const packageJsonPath = path.join(packageRoot, "package.json");
  let packageJson: any = null;
  if (await pathExists(packageJsonPath)) {
    // A package.json that exists but won't parse is a real on-disk problem
    // (corrupted install, half-written file from an interrupted `npm install`,
    // hand-edited typo). Surface it — silently falling through to the
    // direct-path branch produces an opaque "missing create or register"
    // error instead of "your package.json is broken."
    const raw = await fs.readFile(packageJsonPath, "utf8");
    try {
      packageJson = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `[telo] failed to parse ${packageJsonPath}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  const entryValue = entry.trim();
  const exportTarget = resolvePackageExportTarget(packageJson?.exports, entryValue, conditions);
  if (exportTarget) {
    const hit = await tryResolveFile(path.resolve(packageRoot, exportTarget));
    if (hit) return hit;
  }
  if ((entryValue === "." || entryValue === "./") && packageJson) {
    for (const field of ["module", "main"]) {
      const target = packageJson[field];
      if (typeof target !== "string") continue;
      const hit = await tryResolveFile(path.resolve(packageRoot, target));
      if (hit) return hit;
    }
  }
  const direct = await tryResolveFile(path.resolve(packageRoot, entryValue));
  if (direct) return direct;

  throw new Error(`Controller entry "${entryValue}" could not be resolved in ${packageRoot}`);
}

/**
 * Try a path verbatim, then with `.js` appended if it has no extension.
 * Returns the first path that exists, or null if neither does. Centralizes
 * the extension-fallback rule so it's not repeated at every call site.
 */
async function tryResolveFile(absPath: string): Promise<string | null> {
  if (await pathExists(absPath)) return absPath;
  if (!path.extname(absPath)) {
    const withJs = `${absPath}.js`;
    if (await pathExists(withJs)) return withJs;
  }
  return null;
}

function resolvePackageExportTarget(
  exportsField: any,
  entry: string,
  conditions: ReadonlyArray<string>,
): string | null {
  if (!exportsField) return null;
  const key = entry === "." || entry === "./" ? "." : entry;
  return resolveExportTargetValue(exportsField[key], conditions, 0);
}

function resolveExportTargetValue(
  target: any,
  conditions: ReadonlyArray<string>,
  depth: number,
): string | null {
  if (depth > EXPORTS_MAX_DEPTH) return null;
  if (!target) return null;
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = resolveExportTargetValue(item, conditions, depth + 1);
      if (resolved) return resolved;
    }
    return null;
  }
  if (typeof target === "object") {
    for (const key of conditions) {
      if (target[key] !== undefined) {
        const resolved = resolveExportTargetValue(target[key], conditions, depth + 1);
        if (resolved) return resolved;
      }
    }
  }
  return null;
}

/**
 * Pure helpers exported under a stable namespace for unit tests. The class
 * itself isn't useful in isolation (it requires a package manager binary, a
 * filesystem, and a network for non-local specs); these are the deterministic
 * parts that benefit from cheap unit coverage and have no side effects.
 *
 * Not part of the kernel's public API — consumers should not import these.
 */
export const __testing__ = {
  normalizeFileSpec,
  resolvePackageExportTarget,
  resolveExportTargetValue,
  tryResolveFile,
  EXPORTS_MAX_DEPTH,
  DEFAULT_RESOLVER_CONDITIONS,
  REALM_COLLAPSE_NAMES,
};
