import type { ResourceManifest } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import { celEvalModeAt, type CelEvalSites } from "./eval-paths.js";
import type { ReachSite } from "./reference-reach.js";
import { pointerSegments } from "./resource-rule.js";
import { isInlineDeclaration } from "./resolved-reference.js";
import { forEachStep, stepBodiesOf } from "./step-bodies.js";
import { placeAt, READS_IDENTITY, type ReadPlace, type ReadReporter } from "./read-place.js";

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

/**
 * What decides where a declaration's CEL sees a scope's members: the places it
 * holds an inline declaration — a reference site or a step's dispatch slot
 * holding one, decided by where the kind says a reference is and never by an
 * object's shape — and how each of its fields is evaluated.
 */
export interface CelScopeHolder {
  readonly inline: readonly (readonly (string | number)[])[];
  readonly evalSites: CelEvalSites | undefined;
}

/** The {@link CelScopeHolder} of `declaration`, from its reach `sites`, its
 *  kind's author `schema` (for its step bodies) and its eval sites. */
export function celScopeHolder(
  declaration: unknown,
  sites: readonly ReachSite[],
  schema: Record<string, any> | undefined,
  evalSites: CelEvalSites | undefined,
): CelScopeHolder {
  const inline: (readonly (string | number)[])[] = [];
  for (const site of sites) {
    if (site.refs.length > 0 && isInlineDeclaration(site.data)) inline.push(site.keys);
  }
  if (schema && declaration && typeof declaration === "object") {
    for (const body of stepBodiesOf(declaration as Record<string, unknown>, schema)) {
      forEachStep(body, schema, (step, stepPath) => {
        if (isInlineDeclaration(step[body.invokeField])) {
          inline.push(pathKeys(`${stepPath}.${body.invokeField}`));
        }
      });
    }
  }
  return { inline, evalSites };
}

/**
 * The scope among `scopes` whose members a CEL `resources` read at `path` on
 * the declaration `holder` describes sees: the one whose region holds the place
 * — unless an inline declaration written there holds it, whose fields are its
 * own and read where it is created, or the field is evaluated at load, before
 * any scope run opens. A scope run's `resources` is the module's readings plus
 * that run's own members, so the answer is one scope, never a chain.
 */
export function celScopeAt<S extends { readonly regions: readonly (readonly string[])[] }>(
  holder: CelScopeHolder,
  scopes: readonly S[],
  path: string,
): S | undefined {
  if (scopes.length === 0) return undefined;
  const keys = pathKeys(path);
  if (holder.inline.some((at) => keysUnder(keys, at))) return undefined;
  if (holder.evalSites && celEvalModeAt(holder.evalSites, path) === "compile") return undefined;
  return scopes.find((scope) => scope.regions.some((region) => keysUnder(keys, region)));
}

/** A dotted concrete path (`steps[0].invoke`) as its keys. */
function pathKeys(path: string): string[] {
  return path.split(/[.[\]]/).filter((key) => key !== "");
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

/** Why `name`, declared in `scope`, does not reach an inline declaration written
 *  in that scope's region, and what to write instead — the one wording every
 *  diagnostic about such a name uses. */
export function outOfReachSentence(name: string, scope: OutsideScope): string {
  return (
    `'${name}' is declared in '${scope.field}:' of ${scope.ownerKind}/${scope.ownerName}, but this ` +
    `inline declaration is created where '${scope.ownerName}' is declared, outside that scope. ` +
    `Declare it under '${scope.field}:' with a name of its own and point at it with '!ref'.`
  );
}

/** The scopes recorded as out of reach for an extracted declaration. */
export function outsideScopesOf(manifest: unknown): OutsideScope[] {
  const origin = (
    (manifest as { metadata?: { xTeloOrigin?: { outsideScopes?: unknown } } } | undefined)
      ?.metadata?.xTeloOrigin
  )?.outsideScopes;
  return Array.isArray(origin) ? (origin as OutsideScope[]) : [];
}

/** What `x-telo-scope` reads: each field holding the scope's members — a
 *  declaration a name written there may resolve to, by its identity. */
export const scopeReads: ReadReporter = ({ value }) => {
  const pointers = Array.isArray(value) ? value : [value];
  return pointers.flatMap((pointer): ReadPlace[] =>
    typeof pointer === "string" ? [{ kind: "reference", keys: placeAt([], pointer), transitive: false, reads: READS_IDENTITY }] : [],
  );
};
