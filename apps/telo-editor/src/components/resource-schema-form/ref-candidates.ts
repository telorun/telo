import { isRefSentinel, makeTaggedSentinel, type TaggedSentinel } from "@telorun/templating";
import { isRecord } from "../../lib/utils";
import type { ResolvedResourceOption } from "./types";

/** Parsed `x-telo-ref` target, e.g. "telo#Mount" → { scope: "telo", symbol: "Mount" }. */
interface ParsedRefTarget {
  scope: string;
  symbol: string;
}

function parseRefTarget(refTarget: string): ParsedRefTarget | null {
  const hashIndex = refTarget.indexOf("#");
  if (hashIndex < 1 || hashIndex === refTarget.length - 1) return null;
  return {
    scope: refTarget.slice(0, hashIndex).toLowerCase(),
    symbol: refTarget.slice(hashIndex + 1),
  };
}

function normalizeCapability(capability: string): string {
  return capability.trim().toLowerCase();
}

/** The slice of `AnalysisRegistry` candidate resolution needs. Declared here so
 *  the form layer stays decoupled from the analyzer package — `AnalysisRegistry`
 *  satisfies it structurally. */
export interface RefResolver {
  /** Canonical (`module.Type`) kinds that satisfy a ref — an abstract expands to
   *  its implementations, a concrete kind yields itself. Undefined when the ref
   *  can't be resolved. */
  acceptedKindsForRef(refTarget: string): Set<string> | undefined;
  /** Canonicalizes an alias-form kind (`Mcp.Redis` → `mcp-client.Redis`). */
  resolveKind(kind: string): string | undefined;
}

/** Resolves one or more `x-telo-ref` target strings against the module's resolved
 *  resources and returns every resource that can fill any of the slots. Dedupes
 *  across targets (for oneOf/anyOf unions). Shared by the detail-pane
 *  `ReferenceSelectField` and the overview-canvas picker so both agree.
 *
 *  When a `registry` is supplied and resolves the ref, candidates are narrowed
 *  by **kind satisfaction** — an abstract ref (e.g. `std/mcp-client#SessionProvider`)
 *  only matches resources whose kind implements that abstract, not every
 *  `Telo.Provider`. Without a registry (or for a ref it can't resolve) it falls
 *  back to the kind/capability heuristic:
 *
 *  - **`telo#X`** — matches any resource whose kind has `capability: Telo.<X>`.
 *  - **concrete kind ref** — matches any resource whose kind ends with `.<symbol>`. */
export function resolveRefCandidates(
  refTargets: string[],
  resolvedResources: ResolvedResourceOption[],
  registry?: RefResolver | null,
): ResolvedResourceOption[] {
  const seen = new Set<string>();
  const candidates: ResolvedResourceOption[] = [];

  for (const refTarget of refTargets) {
    const accepted = registry?.acceptedKindsForRef(refTarget);
    let matches: ResolvedResourceOption[];
    if (accepted) {
      matches = resolvedResources.filter((r) =>
        accepted.has(registry!.resolveKind(r.kind) ?? r.kind),
      );
    } else {
      const parsed = parseRefTarget(refTarget);
      if (!parsed) continue;
      matches =
        parsed.scope === "telo"
          ? resolvedResources.filter(
              (resource) =>
                resource.capability &&
                normalizeCapability(resource.capability) ===
                  normalizeCapability(`Telo.${parsed.symbol}`),
            )
          : resolvedResources.filter((resource) => resource.kind.endsWith(`.${parsed.symbol}`));
    }

    for (const match of matches) {
      const key = `${match.kind}/${match.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(match);
    }
  }

  return candidates;
}

/** Reads a ref value into the referenced resource **name**. References are
 *  written as `!ref` sentinels (`{ __tagged, engine: "ref", source }`), so the
 *  name is `source`. Legacy `{kind, name}` objects and `"kind.name"` / bare
 *  strings are still read tolerantly — for display only, so an unmigrated file
 *  shows its current selection — and reduced to the name. The caller resolves
 *  the kind from its candidate list. Returns null for malformed input. */
export function parseRefValue(value: unknown): string | null {
  if (isRefSentinel(value)) {
    const dot = value.source.lastIndexOf(".");
    return dot >= 0 ? value.source.slice(dot + 1) : value.source;
  }
  if (typeof value === "string") {
    const dot = value.lastIndexOf(".");
    return dot >= 0 ? value.slice(dot + 1) : value || null;
  }
  if (isRecord(value) && typeof value.name === "string") return value.name;
  return null;
}

/** Stable `"kind.name"` serialization used as a dropdown key. */
export function toRefString(option: { kind: string; name: string }): string {
  return `${option.kind}.${option.name}`;
}

/** Serializes a resolved candidate as a `!ref` sentinel — the only reference
 *  form Telo accepts. The referenced resource's name is the sentinel source. */
export function toRefValue(option: { kind: string; name: string }): TaggedSentinel {
  return makeTaggedSentinel("ref", option.name);
}

/** Collects every `x-telo-ref` target from a property, including refs buried
 *  inside `oneOf` / `anyOf` alternatives. */
export function collectRefTargets(
  prop: Record<string, unknown> & {
    "x-telo-ref"?: unknown;
    oneOf?: Array<Record<string, unknown>>;
    anyOf?: Array<Record<string, unknown>>;
  },
): string[] {
  const targets: string[] = [];
  const direct = prop["x-telo-ref"];
  if (typeof direct === "string") targets.push(direct);
  for (const item of prop.anyOf ?? prop.oneOf ?? []) {
    if (item && typeof item === "object" && typeof item["x-telo-ref"] === "string") {
      targets.push(item["x-telo-ref"] as string);
    }
  }
  return targets;
}
