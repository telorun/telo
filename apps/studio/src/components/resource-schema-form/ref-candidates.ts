import { readRefSlot } from "@telorun/analyzer";
import { isRefSentinel, makeTaggedSentinel, type TaggedSentinel } from "@telorun/templating";
import { isRecord } from "../../lib/utils";
import type { ResolvedResourceOption } from "./types";

/** Parsed `x-telo-ref` target, e.g. "Telo.Mount" → { scope: "telo", symbol: "Mount" }. */
interface ParsedRefTarget {
  scope: string;
  symbol: string;
}

/** Splits a constraint into its scope and kind name. Handles both the current
 *  dotted form — an alias (`Http.Api`), `Self`, `Telo`, or the canonical
 *  `<module>.<Kind>` the analyzer rewrites to — and the legacy
 *  `<identity>#<Kind>` form still found in already-published manifests. The
 *  first separator wins, since a module name carries no dot and an identity
 *  carries no `#`. */
function parseRefTarget(refTarget: string): ParsedRefTarget | null {
  const hashIndex = refTarget.indexOf("#");
  const separator = hashIndex >= 0 ? hashIndex : refTarget.indexOf(".");
  if (separator < 1 || separator === refTarget.length - 1) return null;
  return {
    scope: refTarget.slice(0, separator).toLowerCase(),
    symbol: refTarget.slice(separator + 1),
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
  /** Alias-form kinds an author could WRITE to fill this slot. Optional so a
   *  host that supplies only the resolution slice still type-checks; without it
   *  the picker offers existing resources and no create action. */
  userFacingKindsForRef?(refTarget: string): string[] | undefined;
}

/**
 * A ref slot whose target does not exist yet.
 *
 * A picker that can only offer what is already declared is a dead end the moment
 * a module is new: a `Postgres.Schema` needs a `connection:`, nothing in the
 * module is one, and the select reads `(no candidates)` with nowhere to go. The
 * canvas solved this for array slots long ago (create-and-link on the `+`); this
 * is the same operation for a single slot, and for the form.
 *
 * It travels as a MARKER in the form's value tree rather than as a callback,
 * because creating the resource and linking it must be ONE workspace mutation.
 * Two — create, then write the ref — race: the create re-renders the panel, which
 * re-derives its selection context and resets the pending edit, and the second
 * persist reads a workspace snapshot taken before the first. The marker lets the
 * form report *where* the new reference goes without threading a concrete path
 * through every field component, and lets the host apply both halves at once.
 * It is replaced before anything is written, so it never reaches a manifest.
 */
interface PendingRefCreate {
  __createRefKind: string;
}

/** Marks a picker entry as "create one of this kind" rather than a candidate's
 *  ref key. A resource name cannot contain `:`, so no candidate can collide with
 *  it. Owned here beside the marker itself — the two halves of one protocol,
 *  which three separate copies of this string were free to disagree about. */
export const CREATE_REF_OPTION_PREFIX = "::new:";

export function pendingRefCreate(kind: string): unknown {
  return { __createRefKind: kind } satisfies PendingRefCreate;
}

function isPendingRefCreate(value: unknown): value is PendingRefCreate {
  return isRecord(value) && typeof value.__createRefKind === "string";
}

/** Locates the marker in a form's next values, if one is there. Depth-first over
 *  plain containers only — the form's values are plain data, and a tagged
 *  sentinel is an opaque leaf. */
export function findPendingRefCreate(
  value: unknown,
  path: (string | number)[] = [],
): { path: (string | number)[]; kind: string } | undefined {
  if (isPendingRefCreate(value)) return { path, kind: value.__createRefKind };
  if (isRefSentinel(value)) return undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findPendingRefCreate(value[i], [...path, i]);
      if (found) return found;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const found = findPendingRefCreate(child, [...path, key]);
      if (found) return found;
    }
  }
  return undefined;
}

/** The same values with the marker replaced by a real reference. */
export function resolvePendingRefCreate(
  value: unknown,
  path: (string | number)[],
  kind: string,
  name: string,
): unknown {
  if (path.length === 0) return toRefValue({ kind, name });
  const [head, ...rest] = path;
  if (Array.isArray(value) && typeof head === "number") {
    return value.map((item, i) => (i === head ? resolvePendingRefCreate(item, rest, kind, name) : item));
  }
  if (isRecord(value) && typeof head === "string") {
    return { ...value, [head]: resolvePendingRefCreate(value[head], rest, kind, name) };
  }
  return value;
}

/** Resolves one or more `x-telo-ref` target strings against the module's resolved
 *  resources and returns every resource that can fill any of the slots. Dedupes
 *  across targets (for oneOf/anyOf unions). Shared by the detail-pane
 *  `ReferenceSelectField` and the overview-canvas picker so both agree.
 *
 *  When a `registry` is supplied and resolves the ref, candidates are narrowed
 *  by **kind satisfaction** — an abstract ref (e.g. `Mcp.SessionProvider`)
 *  only matches resources whose kind implements that abstract, not every
 *  `Telo.Provider`. Without a registry (or for a ref it can't resolve) it falls
 *  back to the kind/capability heuristic:
 *
 *  - **`Telo.X`** — matches any resource whose kind has `capability: Telo.<X>`.
 *  - **any other kind ref** — matches any resource whose kind ends with `.<symbol>`. */
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

/**
 * The kind of a resource declared INLINE at a reference slot, or null.
 *
 * A ref slot accepts two shapes, and they are told apart by `name`: the
 * reference the loader produces carries `{kind, name}`, while an inline
 * declaration is `{kind, ...config}` with no name — it exists nowhere but this
 * slot, so there is nothing to name it by. Every surface that reads a ref slot
 * has to ask, because reading only the reference shape renders an authored
 * declaration as an empty picker and overwrites it on the next selection.
 */
export function inlineResourceKind(value: unknown): string | null {
  if (isRefSentinel(value) || !isRecord(value)) return null;
  if (typeof value.kind !== "string" || value.kind === "") return null;
  return typeof value.name === "string" ? null : value.kind;
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
 *  inside `oneOf` / `anyOf` alternatives.
 *
 *  Delegates to the analyzer's accessor so the picker recognises exactly the
 *  slots the analyzer does — the annotation's shape is read in one place, and
 *  the editor is not a surface that has to be remembered when it changes. */
export function collectRefTargets(prop: Record<string, unknown>): string[] {
  return readRefSlot(prop)?.kinds ?? [];
}
