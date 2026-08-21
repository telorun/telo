import { ControllerInstance, RuntimeError, type Logger } from "@telorun/sdk";
import { BundleControllerLoader } from "./controller-loaders/bundle-loader.js";
import type { ModuleArtifact } from "./bundle/module-artifact.js";
import {
  NO_SIBLING_LIBRARIES,
  type SiblingLibraryMap,
} from "./controller-loaders/sibling-libraries.js";
import { ControllerEnvMissingError, NapiControllerLoader } from "./controller-loaders/napi-loader.js";
import { NpmControllerLoader } from "./controller-loaders/npm-loader.js";
import { ControllerPolicy, DEFAULT_POLICY, POLICY_WILDCARD } from "./runtime-registry.js";

export type { ControllerPolicy } from "./runtime-registry.js";

/**
 * Which branch the per-scheme loader actually took. Cache/local hits resolve in
 * milliseconds; `npm-install`, `cargo-build` and `bundle` are the branches that
 * do real (network or compile) work — `bundle` is reported only when the resolve
 * fetched the module's controller layer, never when it found it already
 * extracted. The CLI uses this to decide whether a "downloading…" line was
 * honest or should be erased, so a source that names work no one waited for
 * turns every warm start into noise.
 */
export type ControllerResolveSource =
  | "local"
  | "node_modules"
  | "cache"
  | "npm-install"
  | "cargo-build"
  | "bundle";

/**
 * A controller candidate that has been *resolved* (verified hostable: package
 * installed / bundle present / crate located) but not yet imported/evaluated.
 * `importInstance` performs the deferred — and expensive — module load; lazy
 * controller loading calls it on the kind's first instantiation. `purl`/`source`
 * are known at resolve time and carried for the load-time events.
 */
export interface ResolvedController {
  purl: string;
  source: ControllerResolveSource;
  importInstance: () => Promise<ControllerInstance>;
  /**
   * How long the caller has waited for this controller, measured from the
   * first {@link ControllerWorkKind} branch it entered — or, when it entered
   * none, from the `importInstance()` call. Resolution is what installs,
   * compiles and fetches, so timing only the import reports a 40-second
   * install as a few milliseconds.
   */
  waitedMs: () => number;
}

/**
 * A branch that makes the caller wait: a registry install, a compile, or a
 * layer transfer. Reported by the sub-loader that is about to enter it, which
 * is the only place that knows — a resolve's `source` is a verdict available
 * only afterwards, and a warm start enters no branch at all, so nothing is
 * announced for it. Reported for work in the resolve *and* the import phase:
 * a dev-mode `pkg:telo` build and a `cargo build` are both paid inside
 * `importInstance`.
 */
export type ControllerWorkKind = "npm-install" | "cargo-build" | "source-build" | "layer-fetch";

/**
 * Sub-loader hook, invoked immediately before entering a {@link
 * ControllerWorkKind} branch. Awaited, so a consumer that renders progress has
 * its line on screen before the wait starts rather than after it.
 */
export type ControllerWorkReporter = (work: ControllerWorkKind) => void | Promise<void>;

export type ControllerLoaderEvent =
  /**
   * A resolved controller is about to be imported. `source` names the branch
   * the resolve took, so a consumer can tell a warm start (`cache` / `local`)
   * from work someone waited for (`npm-install`, `cargo-build`, `bundle`)
   * *before* rendering anything. The event is emitted after resolution
   * precisely so this is known: resolution is what fetches, installs and
   * builds, and an event emitted ahead of it could only speculate.
   */
  | { name: "ControllerLoading"; payload: { purl: string; source: ControllerResolveSource } }
  | {
      name: "ControllerLoaded";
      payload: { purl: string; source: ControllerResolveSource; durationMs: number };
    }
  | { name: "ControllerLoadFailed"; payload: { purl: string; error: string } }
  /**
   * The candidate at `purl` couldn't be tried in this environment (e.g.
   * `pkg:cargo` with no `rustc` on PATH, or an unsupported scheme) and the
   * dispatcher has moved on to the next candidate. Distinct from `Failed`,
   * which is non-recoverable. Consumers that opened a UI element on the
   * matching `ControllerLoading` should close it out here.
   */
  | { name: "ControllerLoadSkipped"; payload: { purl: string; reason: string } }
  /**
   * Real work has started for `purl` — an install, a compile or a transfer is
   * about to run. This is the *only* in-progress signal, and it fires solely
   * on the branch that does the work, so a warm start emits nothing rather
   * than something a consumer has to take back. Closed by the matching
   * `ControllerLoaded` / `ControllerLoadFailed`.
   */
  | { name: "ControllerWorkStarted"; payload: { purl: string; work: ControllerWorkKind } };

/**
 * The dispatcher awaits each emission, so the callback may be async without
 * risking out-of-order delivery (concurrent definition loads emit in
 * parallel; the await pins each pair of `Loading`/`Loaded` events to the
 * same async chain). The kernel's `ctx.emit` is async, hence `Promise<void>`
 * is allowed.
 */
export type ControllerLoaderEmit = (event: ControllerLoaderEvent) => void | Promise<void>;

export interface ControllerLoaderOptions {
  emit?: ControllerLoaderEmit;
  /**
   * URL of the entry manifest. The npm-loader anchors a single per-manifest
   * `<entry-dir>/.telo/npm/` install tree here, so every controller — registry
   * tag or `local_path` — resolves through the same `node_modules`. Required
   * for `pkg:npm` candidates; absent for callers that only resolve `pkg:cargo`
   * (cargo loader has its own per-crate cache and does not need this).
   */
  entryUrl?: string;
  /** Explicit npm install root (`<cache-root>/npm`), threaded from the kernel's
   *  single `resolveCacheRoot`. Overrides the entry-anchored default so a
   *  relocated `TELO_CACHE_DIR` is honoured. */
  installRoot?: string;
  /** The `.telo` cache root for this load. The bundle loader caches a dev build
   *  of a local module's controller source under it; absent simply disables that
   *  path, leaving a prebuilt `path=` to load. */
  cacheRoot?: string;
  /** Where the sub-loaders' diagnostics go — install-lock waits, bundle skips.
   *  Threaded from `ctx.log` so §13.1 holds (no direct `process.stderr`), and so
   *  the bundle-skip diagnostics that replaced `TELO_BUNDLE_DEBUG` actually reach
   *  a sink at trace level instead of a no-op logger. */
  log?: Logger;
}

/**
 * Top-level controller-loader dispatcher. Picks a per-scheme sub-loader by
 * PURL type and applies the resolved selection policy:
 *
 *   ControllerLoader.load(candidates, baseUri, policy)
 *     └─ orderCandidates(candidates, policy)
 *          ├─ pkg:npm   → NpmControllerLoader
 *          └─ pkg:cargo → NapiControllerLoader
 *
 * Recovery: env-missing failures (`ControllerEnvMissingError`) advance to the
 * next candidate. User-code failures (`RuntimeError("ERR_CONTROLLER_BUILD_FAILED" | "ERR_CONTROLLER_INVALID")`)
 * fail hard regardless of remaining candidates.
 *
 * Lifecycle events follow resolution: a candidate this environment cannot host
 * produces a `ControllerLoadSkipped` and nothing else, and only the candidate
 * that resolved gets a `ControllerLoading` (carrying its resolve `source`)
 * followed by `ControllerLoaded` / `ControllerLoadFailed`. In between, the
 * sub-loader announces each branch that makes the caller wait as
 * `ControllerWorkStarted` — the only in-progress signal, and the only one that
 * cannot be emitted for a warm start.
 */
export class ControllerLoader {
  private readonly emit: ControllerLoaderEmit | undefined;
  private readonly npmLoader: NpmControllerLoader;
  private readonly napiLoader: NapiControllerLoader;
  private readonly bundleLoader: BundleControllerLoader;

  constructor(options: ControllerLoaderOptions = {}) {
    this.emit = options.emit;
    this.npmLoader = new NpmControllerLoader({
      entryUrl: options.entryUrl,
      installRoot: options.installRoot,
    });
    if (options.log) this.npmLoader.setLogger(options.log);
    this.napiLoader = new NapiControllerLoader(options.cacheRoot);
    this.bundleLoader = new BundleControllerLoader(options.cacheRoot, options.log);
  }

  async load(
    purlCandidates: string[],
    baseUri: string,
    policy?: ControllerPolicy,
    artifact?: ModuleArtifact,
    libraries: SiblingLibraryMap = NO_SIBLING_LIBRARIES,
  ): Promise<ControllerInstance> {
    // Resolution — which is what installs, compiles and fetches — reports its
    // own work and its own candidate fallthrough, so this is the import half
    // and the announcement of what resolution decided.
    const resolved = await this.resolve(purlCandidates, baseUri, policy, artifact, libraries);
    await this.emit?.({
      name: "ControllerLoading",
      payload: { purl: resolved.purl, source: resolved.source },
    });
    try {
      const instance = await resolved.importInstance();
      await this.emit?.({
        name: "ControllerLoaded",
        payload: { purl: resolved.purl, source: resolved.source, durationMs: resolved.waitedMs() },
      });
      return instance;
    } catch (err) {
      await this.emit?.({
        name: "ControllerLoadFailed",
        payload: { purl: resolved.purl, error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }

  /**
   * Resolve a controller without importing it: pick the first candidate this
   * environment can host (same ordering + env-missing fallback as {@link load}),
   * verify it's present, and return a {@link ResolvedController} whose
   * `importInstance` defers the actual import/eval. Lazy controller loading
   * calls this from the kind's first instantiation — never at boot — so a
   * definition whose candidate list nothing in this environment can host
   * registers fine and errors only when a resource of it is declared (matching
   * the Rust kernel's deferral).
   *
   * Emits `ControllerWorkStarted` whenever a sub-loader enters a branch that
   * makes the caller wait, and `ControllerLoadSkipped` per candidate this
   * environment cannot host. It does NOT announce the load itself: the caller
   * emits ControllerLoading/Loaded around `importInstance`, so those fire when
   * the load actually happens, with the resolved `source` already in hand. A
   * total resolution failure throws, mirroring {@link load}'s aggregated error.
   */
  async resolve(
    purlCandidates: string[],
    baseUri: string,
    policy?: ControllerPolicy,
    artifact?: ModuleArtifact,
    libraries: SiblingLibraryMap = NO_SIBLING_LIBRARIES,
  ): Promise<ResolvedController> {
    if (!purlCandidates || purlCandidates.length === 0) {
      throw new RuntimeError("ERR_CONTROLLER_NOT_FOUND", "Missing controller PURL candidates");
    }
    const effectivePolicy = policy ?? DEFAULT_POLICY;
    const ordered = orderCandidates(purlCandidates, effectivePolicy);
    if (ordered.length === 0) {
      throw new RuntimeError(
        "ERR_CONTROLLER_NOT_FOUND",
        `No controllers match runtime selection [${effectivePolicy.load.join(", ")}]; declared: ${purlCandidates.join(", ")}`,
      );
    }
    const errors: string[] = [];
    for (const purl of ordered) {
      // First work only: an install followed by a compile is one wait, and the
      // clock the caller reads has to start where that wait did. The reporter
      // outlives resolution because the import phase does work too.
      let workStartedAt: number | undefined;
      const report: ControllerWorkReporter = async (work) => {
        workStartedAt ??= Date.now();
        await this.emit?.({ name: "ControllerWorkStarted", payload: { purl, work } });
      };
      try {
        const { source, importInstance } = await this.dispatchResolveOne(
          purl,
          baseUri,
          artifact,
          libraries,
          report,
        );
        let importStartedAt: number | undefined;
        return {
          purl,
          source,
          importInstance: () => {
            importStartedAt ??= Date.now();
            return importInstance();
          },
          waitedMs: () => Date.now() - (workStartedAt ?? importStartedAt ?? Date.now()),
        };
      } catch (err) {
        if (err instanceof ControllerEnvMissingError) {
          errors.push(`${purl}: ${err.message}`);
          await this.emit?.({
            name: "ControllerLoadSkipped",
            payload: { purl, reason: err.message },
          });
          continue;
        }
        await this.emit?.({
          name: "ControllerLoadFailed",
          payload: { purl, error: err instanceof Error ? err.message : String(err) },
        });
        throw err;
      }
    }
    const aggregated = `No controller resolved. Tried ${ordered.length} candidate(s):\n${errors.join("\n")}`;
    await this.emit?.({
      name: "ControllerLoadFailed",
      payload: { purl: ordered[ordered.length - 1], error: aggregated },
    });
    throw new RuntimeError("ERR_CONTROLLER_NOT_FOUND", aggregated);
  }

  private async dispatchResolveOne(
    purl: string,
    baseUri: string,
    artifact: ModuleArtifact | undefined,
    libraries: SiblingLibraryMap,
    report: ControllerWorkReporter,
  ): Promise<{ source: ControllerResolveSource; importInstance: () => Promise<ControllerInstance> }> {
    if (purl.startsWith("pkg:npm")) {
      return this.npmLoader.resolve(purl, baseUri, report);
    }
    if (purl.startsWith("pkg:cargo")) {
      return this.napiLoader.resolve(purl, baseUri, report);
    }
    if (purl.startsWith("pkg:telo")) {
      return this.bundleLoader.resolve(purl, baseUri, artifact, libraries, report);
    }
    throw new ControllerEnvMissingError(`Unsupported PURL scheme: ${purl}`);
  }
}

function getPurlType(purl: string): string {
  const slashIdx = purl.indexOf("/", purl.indexOf(":") + 1);
  return slashIdx === -1 ? purl : purl.slice(0, slashIdx);
}

function orderCandidates(
  candidates: ReadonlyArray<string>,
  policy: ControllerPolicy,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const explicitTypes = new Set(policy.load.filter((t) => t !== POLICY_WILDCARD));

  for (const entry of policy.load) {
    if (entry === POLICY_WILDCARD) {
      for (const candidate of candidates) {
        if (seen.has(candidate)) continue;
        const type = getPurlType(candidate);
        if (!explicitTypes.has(type)) {
          result.push(candidate);
          seen.add(candidate);
        }
      }
    } else {
      for (const candidate of candidates) {
        if (seen.has(candidate)) continue;
        if (getPurlType(candidate) === entry) {
          result.push(candidate);
          seen.add(candidate);
        }
      }
    }
  }
  return result;
}
