import type { ControllerPolicy } from "@telorun/sdk";
import { RuntimeError } from "@telorun/sdk";

export type { ControllerPolicy } from "@telorun/sdk";

/**
 * The PURL-type prefix the kernel itself runs (i.e. "no FFI" controllers
 * for this kernel). For the Node.js kernel, that's `pkg:npm`. A future
 * Rust kernel reports `pkg:cargo` here.
 */
export const KERNEL_NATIVE_PURL_TYPE = "pkg:npm";

/**
 * Wildcard sentinel inside a resolved `ControllerPolicy.load`. Means
 * "all remaining controllers in declaration order, minus PURL types
 * already listed earlier in the same policy." May appear at most once.
 */
export const POLICY_WILDCARD = "*";

/**
 * Maps user-facing runtime labels to PURL-type prefixes. The user-facing
 * label is the implementation directory name a contributor sees at
 * `modules/<name>/<label>/`.
 */
const LABEL_TO_PURL_TYPE: Readonly<Record<string, string>> = {
  nodejs: "pkg:npm",
  rust: "pkg:cargo",
};

/**
 * Labels that only make sense as a single value (`runtime: auto`,
 * `runtime: native`) — they describe a whole policy, not one slot in a
 * list. `any` is also reserved but is allowed as the final list entry,
 * so it is handled separately in `normalizeRuntime`.
 */
const SINGLE_ONLY_LABELS = new Set(["auto", "native"]);

/**
 * Default policy for missing `runtime:` field — equivalent to `runtime: auto`.
 * Tries kernel-native first, then any other declared controller in declaration order.
 */
export const DEFAULT_POLICY: ControllerPolicy = {
  load: [KERNEL_NATIVE_PURL_TYPE, POLICY_WILDCARD],
};

/**
 * Resolve a `runtime:` field value (string, array, or undefined) into a
 * canonical `ControllerPolicy`. Throws `ERR_RUNTIME_INVALID` on:
 *  - empty array
 *  - unknown label
 *  - `any` anywhere but the final list entry
 *  - duplicate label
 */
export function normalizeRuntime(value: string | ReadonlyArray<string> | undefined): ControllerPolicy {
  if (value === undefined) {
    return DEFAULT_POLICY;
  }
  if (typeof value === "string") {
    return resolveSingle(value);
  }
  if (!Array.isArray(value)) {
    throw new RuntimeError(
      "ERR_RUNTIME_INVALID",
      `runtime must be a string or array of strings, got ${typeof value}`,
    );
  }
  if (value.length === 0) {
    throw new RuntimeError(
      "ERR_RUNTIME_INVALID",
      "runtime: [] has no useful meaning. Omit the field for `auto`, or list at least one runtime label.",
    );
  }
  const load: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (typeof entry !== "string") {
      throw new RuntimeError(
        "ERR_RUNTIME_INVALID",
        `runtime list entries must be strings, got ${typeof entry}`,
      );
    }
    if (entry === "any") {
      if (i !== value.length - 1) {
        throw new RuntimeError(
          "ERR_RUNTIME_INVALID",
          "runtime: 'any' may only appear as the last entry in the list",
        );
      }
      load.push(POLICY_WILDCARD);
      continue;
    }
    const purlType = labelToPurlType(entry);
    if (load.includes(purlType)) {
      throw new RuntimeError(
        "ERR_RUNTIME_INVALID",
        `runtime: '${entry}' listed twice (resolves to ${purlType})`,
      );
    }
    load.push(purlType);
  }
  return { load };
}

function resolveSingle(label: string): ControllerPolicy {
  if (label === "auto") {
    return DEFAULT_POLICY;
  }
  if (label === "native") {
    return { load: [KERNEL_NATIVE_PURL_TYPE] };
  }
  if (label === "any") {
    return { load: [POLICY_WILDCARD] };
  }
  return { load: [labelToPurlType(label)] };
}

function labelToPurlType(label: string): string {
  if (SINGLE_ONLY_LABELS.has(label)) {
    throw new RuntimeError(
      "ERR_RUNTIME_INVALID",
      `runtime label '${label}' describes a whole policy and is only valid as a single value, not inside a list`,
    );
  }
  const purlType = LABEL_TO_PURL_TYPE[label];
  if (!purlType) {
    const known = Object.keys(LABEL_TO_PURL_TYPE).concat(["auto", "native", "any"]).sort().join(", ");
    throw new RuntimeError(
      "ERR_RUNTIME_INVALID",
      `Unknown runtime label '${label}'. Known: ${known}`,
    );
  }
  return purlType;
}

/**
 * Stable short hash of a resolved policy, for use as a registry cache key
 * suffix. Two imports with the same resolved policy share a cached
 * controller; divergent policies get separate entries.
 *
 * Both `undefined` (no policy stamped) and any policy structurally equal to
 * `DEFAULT_POLICY` (`runtime: auto`, missing `runtime:`, or any list that
 * normalizes to the auto shape) collapse to the `"default"` fingerprint —
 * the plan's contract is that "missing" is sugar for "auto", so they must
 * share a cache entry.
 */
export function policyFingerprint(policy: ControllerPolicy | undefined): string {
  if (!policy || isDefaultPolicy(policy)) {
    return "default";
  }
  return policy.load.join(",");
}

/**
 * Structural equality check against `DEFAULT_POLICY`. Used at policy-stamp
 * time (import-controller) to skip stamping when the resolved policy is the
 * canonical default — `runtime: auto`, `runtime: [nodejs, any]`, etc. all
 * normalize to the same shape and should be observationally identical to a
 * plain omitted `runtime:` field, both at the fingerprint level (handled by
 * `policyFingerprint`) and at the policy-presence level.
 */
export function isDefaultPolicy(policy: ControllerPolicy): boolean {
  if (policy === DEFAULT_POLICY) return true;
  const a = policy.load;
  const b = DEFAULT_POLICY.load;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
