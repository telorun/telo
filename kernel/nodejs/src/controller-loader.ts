import { ControllerInstance, RuntimeError } from "@telorun/sdk";
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
  | "cargo-build";

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
  private npmLoader = new NpmControllerLoader();
  private napiLoader = new NapiControllerLoader();
  private emit?: ControllerLoaderEmit;

  constructor(options: ControllerLoaderOptions = {}) {
    this.emit = options.emit;
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

  private async dispatchOne(
    purl: string,
    baseUri: string,
  ): Promise<{ instance: ControllerInstance; source: ControllerResolveSource }> {
    if (purl.startsWith("pkg:npm")) {
      return this.npmLoader.load(purl, baseUri);
    }
    if (purl.startsWith("pkg:cargo")) {
      return this.napiLoader.load(purl, baseUri);
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
