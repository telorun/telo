import { isRecord } from "../../lib/utils";
import type { JsonSchemaProperty, ResolvedResourceOption } from "./types";

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

/** Resolves one or more `x-telo-ref` target strings against the module's resolved
 *  resources and returns every resource that can fill any of the slots. Dedupes
 *  across targets (for oneOf/anyOf unions).
 *
 *  Two resolution modes, picked from the ref scope:
 *
 *  - **Abstract capability ref** (`telo#Invocable`, `telo#Mount`) — matches any
 *    resource whose kind has `capability: Telo.<symbol>`. This is the common
 *    case for built-in capabilities.
 *  - **Concrete kind ref** (`std/pipeline#Job`, `std/http-server#Server`) —
 *    matches any resource whose kind ends with `.<symbol>`. Used for referring
 *    to a specific user-defined kind.
 *
 *  Replaces the stale `scope === "kernel"` branch left behind after the
 *  Kernel→Telo rename (post-rename the scope string is "telo", not "kernel"). */
export function resolveRefCandidates(
  refTargets: string[],
  resolvedResources: ResolvedResourceOption[],
): ResolvedResourceOption[] {
  const seen = new Set<string>();
  const candidates: ResolvedResourceOption[] = [];

  for (const refTarget of refTargets) {
    const parsed = parseRefTarget(refTarget);
    if (!parsed) continue;

    const matches =
      parsed.scope === "telo"
        ? resolvedResources.filter(
            (resource) =>
              resource.capability &&
              normalizeCapability(resource.capability) ===
                normalizeCapability(`Telo.${parsed.symbol}`),
          )
        : resolvedResources.filter((resource) => resource.kind.endsWith(`.${parsed.symbol}`));

    for (const match of matches) {
      const key = `${match.kind}/${match.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(match);
    }
  }

  return candidates;
}

/** Parses a ref value (either a `"kind.name"` string or a `{kind, name}`
 *  object) into its components. Returns null for malformed input. */
export function parseRefValue(value: unknown): { kind: string; name: string } | null {
  if (typeof value === "string") {
    const dot = value.lastIndexOf(".");
    if (dot <= 0) return null;
    return { kind: value.slice(0, dot), name: value.slice(dot + 1) };
  }
  if (!isRecord(value)) return null;
  if (typeof value.kind === "string" && typeof value.name === "string") {
    return { kind: value.kind, name: value.name };
  }
  return null;
}

/** Stable `"kind.name"` serialization used as a dropdown key. */
export function toRefString(option: { kind: string; name: string }): string {
  return `${option.kind}.${option.name}`;
}

/** Formats a resolved candidate into the shape the schema expects: a string
 *  `"kind.name"` or an object `{kind, name}`. `mode` comes from
 *  `inferRefMode(prop)` — when the ref slot's schema only allows object form,
 *  string form is unacceptable and vice versa. */
export function toRefValue(
  option: { kind: string; name: string },
  mode: "string" | "object",
): string | { kind: string; name: string } {
  if (mode === "object") return { kind: option.kind, name: option.name };
  return toRefString(option);
}

/** Decides whether a ref slot serializes as a `"kind.name"` string or a
 *  `{kind, name}` object, based on the schema's allowed types across the
 *  property itself and any `oneOf` / `anyOf` alternatives. Object form wins
 *  only when the schema forbids strings — otherwise default to string. */
export function inferRefMode(prop: JsonSchemaProperty | undefined): "string" | "object" {
  if (!prop) return "string";
  const alternatives = [...(prop.oneOf ?? []), ...(prop.anyOf ?? [])];
  const hasString =
    prop.type === "string" || alternatives.some((candidate) => candidate.type === "string");
  const hasObject =
    prop.type === "object" || alternatives.some((candidate) => candidate.type === "object");
  if (hasObject && !hasString) return "object";
  return "string";
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
