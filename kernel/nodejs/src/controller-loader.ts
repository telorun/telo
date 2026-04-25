import { ControllerInstance, RuntimeError } from "@telorun/sdk";
import { ControllerEnvMissingError, NapiControllerLoader } from "./controller-loaders/napi-loader.js";
import { NpmControllerLoader } from "./controller-loaders/npm-loader.js";
import { ControllerPolicy, DEFAULT_POLICY, POLICY_WILDCARD } from "./runtime-registry.js";

export type { ControllerPolicy } from "./runtime-registry.js";

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
 */
export class ControllerLoader {
  private npmLoader = new NpmControllerLoader();
  private napiLoader = new NapiControllerLoader();

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
      try {
        return await this.dispatchOne(purl, baseUri);
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

  private async dispatchOne(purl: string, baseUri: string): Promise<ControllerInstance> {
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
