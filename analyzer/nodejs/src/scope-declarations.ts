import type { ResourceManifest } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import { isScopeEntry, resolveFieldEntries, type ReferenceFieldMap } from "./reference-field-map.js";

/**
 * The execution scopes ONE resource declares — the `x-telo-scope` arrays it
 * holds — read off its kind's field map, which is the analyzer's single
 * definition of "scope" (the same one `resolve-ref-sentinels` and
 * `manifest-visitor` read). Inferring a scope from shape instead would give one
 * to any kind that happens to carry an array of named declarations.
 *
 * Browser-safe.
 */

/** One declared scope: the array a scope run creates, and where its names resolve. */
export interface DeclaredScope {
  /** Concrete path of the scope slot on its resource (`with`). */
  path: string;
  /** The declaration array itself — what a scope run registers and tears down. */
  declarations: unknown[];
  /** Dot-form prefixes of every region its names resolve in (`steps`, `targets`). */
  regions: string[];
}

export type ScopeMember = ResourceManifest & { metadata: { name: string } };

/** Every scope `resource` declares, in field-map order. A scope slot left unset
 *  declares nothing: no scope run happens, so nothing is created in one. */
export function declaredScopes(
  resource: Record<string, unknown>,
  fieldMap: ReferenceFieldMap | undefined,
): DeclaredScope[] {
  if (!fieldMap) return [];
  const out: DeclaredScope[] = [];
  for (const [fieldPath, entry] of fieldMap) {
    if (!isScopeEntry(entry)) continue;
    const pointers = Array.isArray(entry.scope) ? entry.scope : [entry.scope];
    const regions = pointers.map((p) => p.replace(/^\//, "").replace(/\//g, "."));
    for (const { value, path } of resolveFieldEntries(resource, fieldPath)) {
      if (Array.isArray(value)) out.push({ path, declarations: value, regions });
    }
  }
  return out;
}

/** True when `path` — a field-map path (`steps[].invoke`) or a concrete one
 *  (`steps[0].invoke`) — lies inside one of the scope's regions. */
export function scopeEncloses(scope: DeclaredScope, path: string): boolean {
  return scope.regions.some(
    (region) => path === region || path.startsWith(`${region}.`) || path.startsWith(`${region}[`),
  );
}

/** A scope's inline resource declarations. A `!ref` entry is a category error
 *  (`SCOPE_ENTRY_NOT_INLINE`), not a member. */
export function scopeMembers(scope: DeclaredScope): ScopeMember[] {
  return scope.declarations.filter(isScopeMember);
}

/** True when a scope array entry is an inline resource declaration. */
export function isScopeMember(value: unknown): value is ScopeMember {
  if (!value || typeof value !== "object" || Array.isArray(value) || isRefSentinel(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  const name = (entry.metadata as { name?: unknown } | undefined)?.name;
  return typeof entry.kind === "string" && typeof entry.name !== "string" && typeof name === "string";
}

/**
 * A scope an extracted declaration was WRITTEN inside and is NOT created in.
 *
 * An inline declaration is created in the set its owner is declared in, never in
 * a scope its owner declares — moving it there would make every step target of a
 * sequence with a `with:` block a scoped resource, which is a change of durable
 * identity. So a declaration written in `steps:` next to a `with:` block is
 * lexically inside that scope and lives outside it, and the names the scope
 * declares are out of its reach. Recorded at extraction, where both facts are in
 * hand, as `metadata.xTeloOrigin.outsideScopes`.
 */
export interface OutsideScope {
  /** The resource declaring the scope, as its manifest spells it. */
  ownerKind: string;
  ownerName: string;
  /** The scope slot (`with`). */
  field: string;
  /** Every name the scope declares. */
  names: string[];
}

/** The scopes recorded as out of reach for an extracted declaration. */
export function outsideScopesOf(manifest: unknown): OutsideScope[] {
  const origin = (
    (manifest as { metadata?: { xTeloOrigin?: { outsideScopes?: unknown } } } | undefined)
      ?.metadata?.xTeloOrigin
  )?.outsideScopes;
  return Array.isArray(origin) ? (origin as OutsideScope[]) : [];
}
