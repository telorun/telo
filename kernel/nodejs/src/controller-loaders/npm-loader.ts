import { ControllerInstance, NOOP_LOGGER, type Logger } from "@telorun/sdk";
import { execFile } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import { createRequire } from "module";
import * as os from "os";
import { PackageURL } from "packageurl-js";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { promisify } from "util";
import { hostEnv } from "../host-env.js";
import { tryBuildControllerBundle } from "./bundle-builder.js";
import { ControllerEnvMissingError } from "./napi-loader.js";
import { REALM_COLLAPSE_NAMES } from "./realm.js";

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

/**
 * Package-manager binary used for `<root>/.telo/npm/` installs. Captured once
 * at module load so a mid-process env mutation can't change which binary
 * runs for half an install batch — the kernel's controller installs are
 * sequenced, but predictability beats late-binding here. Override via
 * `TELO_PKG_MANAGER` (e.g. `pnpm`, `bun`).
 */
const PACKAGE_MANAGER = hostEnv().TELO_PKG_MANAGER ?? "npm";

/**
 * Make the installer ignore controllers' declared `peerDependencies` ranges.
 * A pinned controller tarball is immutable: it carries whatever `@telorun/sdk`
 * peer range was current when it was published. The install root provides the
 * kernel's own (newer) sdk as a `file:` dep (the realm-collapse mechanism), so
 * npm 7+'s strict peer resolver `ERESOLVE`-aborts when that version falls
 * outside the old range — even though the sdk surface is backward compatible
 * and the controller would run fine. Telling the package manager to disregard
 * declared peers restores npm ≤6 behavior: it uses the provided sdk and never
 * fails on the range. Safe as long as the sdk stays backward compatible.
 */
const PEER_INSTALL_FLAGS: ReadonlyArray<string> =
  PACKAGE_MANAGER === "npm"
    ? ["--legacy-peer-deps"]
    : PACKAGE_MANAGER === "pnpm"
      ? ["--no-strict-peer-dependencies"]
      : [];

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
 * Total wall-clock cap for waiting on the install lock — enough for a slow
 * first install on a peer process to finish, short enough that a genuinely
 * deadlocked CI job fails loudly rather than hanging for hours. The retry
 * interval trades wakeup latency vs. wasted polls; 500ms is well below the
 * lock holder's typical hold time.
 */
const LOCK_WAIT_MAX_MS = 5 * 60_000;
const LOCK_RETRY_MS = 500;

/** After this long waiting on a lock, emit one stderr line so a slow wait is
 *  visible instead of looking like a silent hang. */
const LOCK_WAIT_NOTICE_MS = 2_000;

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
  /**
   * Explicit install root, threaded from the kernel's single `resolveCacheRoot`
   * (`<cache-root>/npm`). When set it overrides the entry-anchored
   * `computeInstallRoot`, so a relocated `TELO_CACHE_DIR` (e.g. a prebuilt
   * image baking deps at `/telo-cache`) is honoured without this loader reading
   * the env itself.
   */
  installRoot?: string;
}

/**
 * The npm-loader maintains a single install root per kernel process. For a
 * local entry manifest (`file://` URL or bare path) the root lives at
 * `<entry-manifest-dir>/.telo/npm/`; for an HTTP(S) entry URL it lives in a
 * user-level cache keyed by `sha256(entryUrl)` (see `computeInstallRoot`).
 * Every controller — registry tag or `local_path` — is installed under a
 * version-scoped npm alias (`npm install <alias>@<spec>`, see `installAlias`)
 * into this root, then imported from `<root>/node_modules/<alias>`. The alias
 * encodes `name@version`, so a graph that references one package at two
 * versions keeps both in the single flat `node_modules` instead of the last
 * `--save` clobbering the first. This still collapses two parallel module
 * realms (kernel-side @telorun/sdk vs. controller-side @telorun/sdk) into one:
 * `@telorun/sdk` is exempt from aliasing and wired in as a `file:` dep under
 * its real name, npm/pnpm hoist a single copy, and Node's ESM resolver follows
 * it to the same realpath as the kernel — so `Stream` (and any other
 * class-identity-sensitive type) has a single constructor across the process.
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
  /** Where install-lock diagnostics go. Injected rather than written to
   *  `process.stderr`: this loader runs outside the kernel's stdio scope, and
   *  §13.1 routes every kernel diagnostic through the logger. */
  private log: Logger = NOOP_LOGGER;

  /** Route this loader's diagnostics through the kernel's logger. */
  setLogger(log: Logger): void {
    this.log = log;
  }

  private readonly entryUrl?: string;
  /** Threaded install root (`<cache-root>/npm`); overrides `computeInstallRoot`. */
  private readonly installRootOverride?: string;

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
    this.installRootOverride = options.installRoot;
  }

  async load(purl: string, baseUri: string): Promise<NpmLoadResult> {
    const { source, importInstance } = await this.resolve(purl, baseUri);
    return { instance: await importInstance(), source };
  }

  /**
   * Resolve without importing: materialize the install root and install/verify
   * the package (the cheap, cache-hit-fast part that fails fast if the package
   * is absent), but defer `loadFromInstall` — the actual `import()`/eval, which
   * is the expensive cold-start cost — into the returned `importInstance` thunk.
   */
  async resolve(
    purl: string,
    baseUri: string,
  ): Promise<{ source: NpmResolveSource; importInstance: () => Promise<ControllerInstance> }> {
    const parsed = PackageURL.fromString(purl);
    if (!parsed.name) {
      throw new Error(`Invalid PURL '${purl}': missing package name`);
    }
    const packageName = parsed.namespace ? `${parsed.namespace}/${parsed.name}` : parsed.name;
    const version = parsed.version ?? null;
    // Version-scope the install under an alias so the same package at two
    // versions can coexist in one flat node_modules (see installAlias).
    const alias = installAlias(packageName, version);

    const installRoot = await this.ensureInstallRoot();
    const resolved = await resolveInstallSpec(parsed, packageName, baseUri);
    const source = await this.installPackage(
      installRoot,
      alias,
      resolved.spec,
      resolved.kind,
      version,
    );
    const subpath = parsed.subpath ?? null;
    return {
      source,
      importInstance: () => loadFromInstall(installRoot, alias, subpath, purl, this.log),
    };
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
    const installRoot = this.installRootOverride ?? computeInstallRoot(entryUrlStr);

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
      await runPackageManager(installRoot, [
        "install",
        "--no-audit",
        "--no-fund",
        "--silent",
        ...PEER_INSTALL_FLAGS,
      ]);
      await fs.writeFile(stateFile, JSON.stringify({ rootHash: newHash }, null, 2) + "\n");
    }, this.log);

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
    // `dependencies` is only the realm-collapse deps (`@telorun/sdk`), keyed by
    // real `name@spec`. Controllers, by contrast, key `installedSpecs` by their
    // version-scoped alias in `installPackage`. The two key spaces are
    // intentionally disjoint — realm-collapse names are wired in here and never
    // flow through `installPackage`, so an alias and a `name@spec` never clash.
    for (const [name, spec] of Object.entries(dependencies)) {
      this.installedSpecs.add(`${name}@${spec}`);
    }
    this.rootDeps = (await readPackageDeps(installRoot)) ?? { ...dependencies };
  }

  /**
   * Install one controller into the existing root under its version-scoped
   * `alias` folder. Single-flight per alias within the process; cross-process
   * safety is the fs-lock around the `npm install` call. If the alias is
   * already installed (right version on disk, or a matching `file:` record),
   * skip — reusing the previous install.
   *
   * `spec` is the source half of the install (`npm:<name>@<version>` or
   * `file:<abs>`); the package manager is invoked with `<alias>@<spec>`.
   * `kind` distinguishes a `local_path` source (loader synthesized `file:`
   * spec) from a registry tag. The CLI silences progress for both `cache`
   * and `local`; `npm-install` is the only event surfaced. Folding this
   * decision in here means the caller no longer needs to override the
   * returned source after the fact.
   */
  private async installPackage(
    installRoot: string,
    alias: string,
    spec: string,
    kind: SpecKind,
    requestedVersion: string | null,
  ): Promise<NpmResolveSource> {
    const cacheKey = alias;
    if (this.installedSpecs.has(cacheKey)) return "cache";

    const inFlight = this.inFlight.get(cacheKey);
    if (inFlight) {
      await inFlight;
      return "cache";
    }

    // The package is installed under its version-scoped alias, so its folder
    // name in node_modules is the alias, not the bare package name.
    const targetPath = path.join(installRoot, "node_modules", alias);

    // Registry fast path: compare against the installed package's own
    // `package.json` version field. The recorded dep spec can't be used here
    // because npm rewrites registry specs on `--save` — we pass
    // `<alias>@npm:@scope/pkg@0.3.4`, npm writes `npm:@scope/pkg@^0.3.4` — so a
    // string comparison never matches and every fresh `NpmControllerLoader`
    // (one per `Telo.Definition.init`) would fall through to a no-op but ~200ms
    // `npm install`. Reading the installed package.json sidesteps that
    // entirely: if the requested PURL version equals what's on disk under this
    // alias, we already have the right thing. Because the alias encodes the
    // version, a present alias folder is always the requested version.
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
    } else {
      // Local (`file:`) spec fast path: consult the in-process snapshot of the
      // install root's `dependencies` map (seeded by `materializeInstallRoot`).
      // Normalize because npm rewrites absolute `file:` deps to relative paths
      // inside the install root's `package.json` — the loader passes the
      // absolute path, the on-disk record is `file:../../foo`.
      const cachedSpec = this.rootDeps[alias];
      if (
        cachedSpec !== undefined &&
        normalizeFileSpec(cachedSpec, installRoot) === normalizeFileSpec(spec, installRoot) &&
        (await pathExists(targetPath))
      ) {
        this.installedSpecs.add(cacheKey);
        return "cache";
      }
    }

    const work = (async () => {
      await withInstallLock(installRoot, async () => {
        // Re-check inside the lock: a peer process may have installed the
        // spec between the fast-path miss and our acquisition.
        if (kind === "registry") {
          const installedVersion = await readInstalledVersion(targetPath);
          if (
            installedVersion !== null &&
            (requestedVersion === null || requestedVersion === installedVersion)
          ) {
            return;
          }
        } else {
          // Normalize the on-disk record to absolute form before comparing —
          // npm rewrites `file:` deps to be relative to the install root.
          const lockedSpec = await readDepSpec(installRoot, alias);
          if (
            lockedSpec !== undefined &&
            normalizeFileSpec(lockedSpec, installRoot) === normalizeFileSpec(spec, installRoot) &&
            (await pathExists(targetPath))
          ) {
            this.rootDeps[alias] = lockedSpec;
            return;
          }
        }

        await runPackageManager(installRoot, [
          "install",
          "--no-audit",
          "--no-fund",
          "--silent",
          ...PEER_INSTALL_FLAGS,
          "--save",
          // `<alias>@<source-spec>` installs the package under the alias folder
          // (`npm:` for registry, `file:` for local) so multiple versions of
          // one package name coexist in the single install root.
          `${alias}@${spec}`,
        ]);
        // Re-read what npm actually wrote (it normalizes `file:` paths to
        // be relative to the install root). Caching the spec in its on-disk
        // form keeps subsequent fast-path comparisons stable.
        const written = await readDepSpec(installRoot, alias);
        if (written !== undefined) this.rootDeps[alias] = written;
        else this.rootDeps[alias] = spec;
      }, this.log);
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
 * Serialize same-process callers for one install root, in memory, ahead of the
 * filesystem lock.
 *
 * Package installs dedupe per alias, so N distinct controllers are N distinct
 * `withInstallLock` calls against the SAME root. Without this queue they all
 * contend through the filesystem: one wins and the rest poll `fs.open` every
 * {@link LOCK_RETRY_MS} for the whole install, each crossing
 * {@link LOCK_WAIT_NOTICE_MS} and printing the wait notice — a notice whose
 * whole point is "another Telo *process* holds this", which is misleading when
 * the holder is us. (`telo install` fanning 52 controllers out through one
 * `Promise.allSettled` printed 51 of them.)
 *
 * Queuing here means exactly one caller per process reaches the fs lock, so the
 * notice regains its cross-process meaning and the losers do no I/O at all. The
 * fs lock is untouched and still provides the cross-process guarantee.
 */
const localInstallQueues = new Map<string, Promise<unknown>>();

function withLocalInstallQueue<T>(installRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = localInstallQueues.get(installRoot) ?? Promise.resolve();
  // Run on both settle paths: one failed install must not wedge the queue.
  const run = prev.then(fn, fn);
  // The stored tail never rejects — a failure neither poisons followers nor
  // surfaces as an unhandled rejection on the chain copy.
  const tail = run.then(
    () => {},
    () => {},
  );
  localInstallQueues.set(installRoot, tail);
  // Drop the entry once nothing further is queued, so a long-lived process that
  // touches many entry dirs doesn't retain a promise per root forever.
  void tail.then(() => {
    if (localInstallQueues.get(installRoot) === tail) localInstallQueues.delete(installRoot);
  });
  return run;
}

/**
 * Acquire the install lock for `installRoot` and run `fn` under it: first the
 * in-process queue above, then the cross-process filesystem lock.
 */
async function withInstallLock<T>(
  installRoot: string,
  fn: () => Promise<T>,
  log: Logger = NOOP_LOGGER,
): Promise<T> {
  return withLocalInstallQueue(installRoot, () => withFileInstallLock(installRoot, fn, log));
}

/**
 * Acquire a process-portable lock on `<root>/.lock` and execute fn while
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
 * The lock guards the install-root manifest write, the package-manager
 * invocation, and any state-file writes. It does NOT serialize *reads* of
 * already-installed controllers — those run lock-free against a stable tree.
 */
async function withFileInstallLock<T>(
  installRoot: string,
  fn: () => Promise<T>,
  log: Logger = NOOP_LOGGER,
): Promise<T> {
  const lockPath = path.join(installRoot, ".lock");

  await fs.mkdir(installRoot, { recursive: true });

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
          `[telo] timed out waiting for install lock at ${lockPath} ` +
            `(held >${LOCK_WAIT_MAX_MS / 60_000} min with a live heartbeat). ` +
            `Inspect the lock file or remove it manually if no other Telo process is running.`,
        );
      }
      if (!noticed && waited > LOCK_WAIT_NOTICE_MS) {
        noticed = true;
        log.info("waiting for controller install lock", { "telo.install.lock_path": lockPath });
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  // Keep the lock fresh while `fn` runs so a slow-but-live install is never
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
        log.warn(
          "failed to release install lock",
          { "telo.install.lock_path": lockPath },
          { error: err },
        );
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

async function runPackageManager(cwd: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(PACKAGE_MANAGER, args, { cwd, maxBuffer: 32 * 1024 * 1024, env: hostEnv() });
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
 * Decide where the per-kernel install root lives for a given entry URL.
 *
 * - `file://` URL or bare filesystem path: anchored next to the manifest at
 *   `<entry-dir>/.telo/npm/`. Same as before — keeps the "install lives with
 *   the project" story for local development and Docker builds where the
 *   tree is `COPY`-d into the image.
 * - `http(s)://` URL: there is no on-disk anchor next to the manifest, so
 *   the install root lives in a user-level cache keyed by the SHA-256 of
 *   the entry URL: `<cacheDir>/<hash>/npm/`. Repeat runs of the same URL
 *   hit the same cache; distinct URLs get isolated trees so two unrelated
 *   remote apps don't share `node_modules` (different controller versions,
 *   different realm-collapse pins).
 *
 *   Cache location, in priority order:
 *     1. `$TELO_NPM_CACHE_DIR` (explicit override — tests use this to avoid
 *        polluting the developer's `~/.cache`).
 *     2. `$XDG_CACHE_HOME/telo/remote` (standard XDG path on Linux).
 *     3. `<os.homedir()>/.cache/telo/remote` (POSIX fallback / macOS).
 *
 * Unrecognised schemes (anything that isn't `file://`, `http://`, or
 * `https://`) still throw `ControllerEnvMissingError` so the dispatcher can
 * advance to a non-npm candidate.
 */
function computeInstallRoot(entryUrl: string): string {
  if (entryUrl.startsWith("file://")) {
    const entryPath = fileURLToPath(entryUrl);
    return path.join(path.dirname(path.resolve(entryPath)), ".telo", "npm");
  }
  const schemeMatch = entryUrl.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (!schemeMatch) {
    // Bare filesystem path: same anchor as `file://`.
    return path.join(path.dirname(path.resolve(entryUrl)), ".telo", "npm");
  }
  const scheme = schemeMatch[1].toLowerCase();
  if (scheme === "http" || scheme === "https") {
    const env = hostEnv();
    const cacheBase =
      env.TELO_NPM_CACHE_DIR ||
      (env.XDG_CACHE_HOME
        ? path.join(env.XDG_CACHE_HOME, "telo", "remote")
        : path.join(os.homedir(), ".cache", "telo", "remote"));
    return path.join(cacheBase, sha256(entryUrl), "npm");
  }
  // Env-missing rather than a hard error: the dispatcher should advance to
  // the next candidate when a non-npm scheme is paired with a `pkg:cargo`
  // (or other) fallback.
  throw new ControllerEnvMissingError(
    `[telo] entry URL scheme '${schemeMatch[1]}' is not supported by the npm controller ` +
      `loader. Supported schemes: file://, http://, https://, or a bare filesystem path. ` +
      `(entryUrl: ${entryUrl})`,
  );
}

/**
 * Version-qualified install alias for a controller package. The kernel's single
 * flat install root can hold only one folder per package name, but a manifest
 * graph may legitimately reference the same package at multiple versions (e.g.
 * a library pins `@telorun/mcp-client@0.3.1` while the app uses `0.4.0`).
 * Installing each `name@version` under a distinct npm alias
 * (`npm install <alias>@npm:<name>@<version>`) lets every version coexist in
 * one `node_modules`, mirroring the per-(name, version) identity of a Telo
 * module singleton. `@telorun/sdk` is intentionally NOT routed through here —
 * it stays under its real name so realm-collapse hoists a single copy across
 * the kernel/controller boundary (see REALM_COLLAPSE_NAMES).
 *
 * The result is a valid unscoped npm package name: the scope `@` is dropped,
 * `/` becomes `__`, and any character outside npm's name grammar is replaced
 * with `-`. Because that sanitization is lossy (e.g. build metadata `1.0.0+x`
 * and prerelease `1.0.0-x` both fold to `1.0.0-x`, and a `__` already in a
 * package name overlaps the scope separator), the alias ends with a short hash
 * of the *exact* `name@version` — so two distinct pairs can never collide onto
 * one folder regardless of how their readable prefixes sanitize. The readable
 * prefix is kept purely so the install tree is greppable.
 */
function installAlias(packageName: string, version: string | null): string {
  const prefix = `${packageName.replace(/^@/, "").replace(/\//g, "__")}__${version ?? "latest"}`
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .toLowerCase();
  const digest = sha256(`${packageName}@${version ?? ""}`).slice(0, 8);
  return `${prefix}__${digest}`;
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
  // `npm:` source spec so the caller can install it under a version-scoped
  // alias (`<alias>@npm:<name>@<version>`); both versions of one package name
  // then coexist in the single flat install root.
  const spec = parsed.version ? `npm:${packageName}@${parsed.version}` : `npm:${packageName}`;
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
  alias: string,
  subpath: string | null,
  purl: string,
  log: Logger = NOOP_LOGGER,
): Promise<ControllerInstance> {
  // The package lives under its version-scoped alias folder (see installAlias),
  // not its bare scoped name.
  const packageRoot = path.join(installRoot, "node_modules", alias);
  const entry = subpath ? `./${subpath}` : ".";
  const entryFile = await resolvePackageEntry(packageRoot, entry);
  // Transparent bundling: import a single esbuild bundle of the entry (one file
  // vs a cold loose `node_modules` tree) when available; otherwise the loose
  // entry. Pure accelerator — `null` on any miss, so behavior is unchanged.
  const target = (await tryBuildControllerBundle(installRoot, entryFile, log)) ?? entryFile;
  // ESM dynamic `import()` accepts either a relative specifier or a `file://`
  // URL — but NOT a bare absolute filesystem path. On POSIX the `/abs/path`
  // form works by happy accident; on Windows `C:\path\to\file.js` is rejected
  // outright. Convert through `pathToFileURL` so the loader behaves the same
  // on both platforms.
  //
  // Dynamic `import()` always resolves to a module namespace object on
  // success; it never returns null/undefined. The only meaningful contract
  // check is whether the module exports at least one of the controller hooks.
  const instance = await import(pathToFileURL(target).href);
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
  installAlias,
  normalizeFileSpec,
  resolvePackageExportTarget,
  resolveExportTargetValue,
  tryResolveFile,
  computeInstallRoot,
  withInstallLock,
  reclaimIfStale,
  LOCK_STALE_MS,
  LOCK_HEARTBEAT_MS,
  EXPORTS_MAX_DEPTH,
  DEFAULT_RESOLVER_CONDITIONS,
  REALM_COLLAPSE_NAMES,
};
