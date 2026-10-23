import type { ResourceManifest } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import type { ReachSite } from "./reference-reach.js";
import { pointerSegments } from "./resource-rule.js";
import { isInlineDeclaration } from "./resolved-reference.js";

/**
 * The execution scopes ONE resource declares — the `x-telo-scope` arrays it
 * holds — read off the concrete sites of its kind's reach, which is the
 * analyzer's single definition of "scope" (the same one `resolve-ref-sentinels`
 * and `manifest-visitor` read). Inferring a scope from shape instead would give
 * one to any kind that happens to carry an array of named declarations.
 *
 * Browser-safe.
 */

/** One declared scope: the array a scope run creates, and where its names resolve. */
export interface DeclaredScope {
  /** Concrete path of the scope slot on its resource (`with`). */
  path: string;
  /** The same path as its keys. */
  keys: readonly (string | number)[];
  /** The declaration array itself — what a scope run registers and tears down. */
  declarations: unknown[];
  /** Every region its names resolve in (`steps`, `targets`), as keys from the
   *  resource root. */
  regions: readonly (readonly string[])[];
}

export type ScopeMember = ResourceManifest & { metadata: { name: string } };

/** Every scope a resource declares, from its concrete sites, in reach order. A
 *  scope slot left unset declares nothing: no scope run happens, so nothing is
 *  created in one. */
export function declaredScopes(sites: readonly ReachSite[]): DeclaredScope[] {
  const out: DeclaredScope[] = [];
  for (const site of sites) {
    if (site.scopes.length === 0 || !Array.isArray(site.data)) continue;
    const regions = new Map<string, readonly string[]>();
    for (const { scope } of site.scopes) {
      for (const pointer of Array.isArray(scope) ? scope : [scope]) {
        const keys = pointerSegments(pointer.startsWith("/") ? pointer : `/${pointer}`);
        if (keys) regions.set(JSON.stringify(keys), keys);
      }
    }
    out.push({ path: site.path, keys: site.keys, declarations: site.data, regions: [...regions.values()] });
  }
  return out;
}

/** True when the concrete place `keys` (`["steps", 0, "invoke"]`) lies inside
 *  one of the scope's regions. */
export function scopeEncloses(scope: DeclaredScope, keys: readonly (string | number)[]): boolean {
  return scope.regions.some((region) => keysUnder(keys, region));
}

/** True when `keys` is `prefix` or lies beneath it; an index matches the
 *  pointer segment spelling it. */
export function keysUnder(
  keys: readonly (string | number)[],
  prefix: readonly (string | number)[],
): boolean {
  return prefix.length <= keys.length && prefix.every((key, i) => String(keys[i]) === String(key));
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
  if (!isInlineDeclaration(value)) return false;
  const name = (value.metadata as { name?: unknown } | undefined)?.name;
  return typeof name === "string";
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
