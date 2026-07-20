import { ControllerInstance, RuntimeError, type Logger } from "@telorun/sdk";
import { BundleControllerLoader } from "./controller-loaders/bundle-loader.js";
import { ControllerEnvMissingError, NapiControllerLoader } from "./controller-loaders/napi-loader.js";
import { NpmControllerLoader } from "./controller-loaders/npm-loader.js";
import { ControllerPolicy, DEFAULT_POLICY, POLICY_WILDCARD } from "./runtime-registry.js";

export type { ControllerPolicy } from "./runtime-registry.js";

/**
 * Which branch the per-scheme loader actually took. Cache/local hits resolve
 * in milliseconds; `npm-install` and `cargo-build` are the only branches that
 * do real (network or compile) work. The CLI uses this to decide whether a
 * "downloading…" line was honest or should be erased.
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
}

export type ControllerLoaderEvent =
  | { name: "ControllerLoading"; payload: { purl: string } }
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
  | { name: "ControllerLoadSkipped"; payload: { purl: string; reason: string } };

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
 * Lifecycle events are emitted per *attempt*, so a fallback chain produces one
 * `ControllerLoading` per candidate tried plus a final `ControllerLoaded` (or
 * `ControllerLoadFailed`) for the one that won.
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
    this.napiLoader = new NapiControllerLoader();
    this.bundleLoader = new BundleControllerLoader();
  }

  async load(
    purlCandidates: string[],
    baseUri: string,
    policy?: ControllerPolicy,
  ): Promise<ControllerInstance> {
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
      await this.emit?.({ name: "ControllerLoading", payload: { purl } });
      const startedAt = Date.now();
      try {
        const { instance, source } = await this.dispatchOne(purl, baseUri);
        await this.emit?.({
          name: "ControllerLoaded",
          payload: { purl, source, durationMs: Date.now() - startedAt },
        });
        return instance;
      } catch (err) {
        if (err instanceof ControllerEnvMissingError) {
          errors.push(`${purl}: ${err.message}`);
          // Env-missing isn't a hard failure — the dispatcher will try the
          // next candidate. We still emit a terminal event for *this* attempt
          // so consumers (notably the CLI progress renderer) can close out
          // the UI state opened by the matching ControllerLoading. Without
          // this, every fallback attempt would leak a pending `⬇` line.
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

  /**
   * Resolve a controller without importing it: pick the first candidate this
   * environment can host (same ordering + env-missing fallback as {@link load}),
   * verify it's present, and return a {@link ResolvedController} whose
   * `importInstance` defers the actual import/eval. Used by lazy controller
   * loading so a `Telo.Definition` fails fast at boot when its controller can't
   * load at all, while the expensive import is paid only on first instantiation.
   *
   * Silent by design — no lifecycle events here; the caller emits
   * ControllerLoading/Loaded around `importInstance` so the events fire when the
   * load actually happens. A total resolution failure throws (the boot-time
   * fail-fast), mirroring {@link load}'s aggregated error.
   */
  async resolve(
    purlCandidates: string[],
    baseUri: string,
    policy?: ControllerPolicy,
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
      try {
        const { source, importInstance } = await this.dispatchResolveOne(purl, baseUri);
        return { purl, source, importInstance };
      } catch (err) {
        if (err instanceof ControllerEnvMissingError) {
          errors.push(`${purl}: ${err.message}`);
          continue;
        }
        throw err;
      }
    }
    throw new RuntimeError(
      "ERR_CONTROLLER_NOT_FOUND",
      `No controller resolved. Tried ${ordered.length} candidate(s):\n${errors.join("\n")}`,
    );
  }

  private async dispatchOne(
    purl: string,
    baseUri: string,
  ): Promise<{ instance: ControllerInstance; source: ControllerResolveSource }> {
    const { source, importInstance } = await this.dispatchResolveOne(purl, baseUri);
    return { instance: await importInstance(), source };
  }

  private async dispatchResolveOne(
    purl: string,
    baseUri: string,
  ): Promise<{ source: ControllerResolveSource; importInstance: () => Promise<ControllerInstance> }> {
    if (purl.startsWith("pkg:npm")) {
      return this.npmLoader.resolve(purl, baseUri);
    }
    if (purl.startsWith("pkg:cargo")) {
      return this.napiLoader.resolve(purl, baseUri);
    }
    if (purl.startsWith("pkg:telo")) {
      return this.bundleLoader.resolve(purl, baseUri);
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
