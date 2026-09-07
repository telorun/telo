import { AliasResolver, scopeResolverForModule, type ModuleScopes } from "./alias-resolver.js";

/**
 * WHICH ALIAS TABLE A MANIFEST'S OWN NAMES ARE WRITTEN IN.
 *
 * An application analysis is flattened, so an imported library's definitions and
 * exported instances are checked in the CONSUMER's pass. But every alias-qualified
 * name on such a manifest — its `kind:`, its `extends:`, an `x-telo-schema-from`
 * anchor — was written against the alias map of the module that DECLARED it. A
 * library writes `kind: Http.Api` through an import the consumer has no reason to
 * have, so resolving it through the entry's table finds nothing, and everything
 * derived from the definition silently goes missing: the field map (Phase-5
 * injection blind to a forwarded resource's ref slots) and the `x-telo-context`
 * regions (`request` / `result` reported as unknown identifiers on a file the
 * consumer cannot edit).
 *
 * **There are TWO fallbacks, not one, and this file is where they are told
 * apart** — that is the whole reason they live together. They agree on every
 * module that has a table, and differ on a non-root module that has none:
 *
 *  - {@link moduleAliasScope} falls back to the GLOBAL table. For a question
 *    asked about an arbitrary manifest, where a missing entry means "this is the
 *    entry's own", which is what the global table answers correctly.
 *  - {@link declaringModuleScope} falls back to an EMPTY table for a non-root
 *    module. For canonicalizing what a library DECLARED, where resolving its
 *    `Http.Api` through the consumer's imports would silently bind a library's
 *    kind to whatever the app happens to import under that alias — a wrong
 *    answer, which is worse than none.
 *
 * Both rest on one invariant neither states inline: **a root module is never a
 * key in `aliasesByModule`** — a root's imports are registered into the global
 * table instead (see the `rootModules` guards in `analyze()`) — so for a
 * consumer-owned manifest the two rules coincide and neither fallback is a
 * degradation.
 *
 * Every READ of the rule goes through one of these two. What legitimately does
 * not, and why, so the next reader does not have to re-derive it: the three
 * sites in `analyze()` that POPULATE `aliasesByModule` (a write, not a lookup),
 * and `resolve-ref-sentinels`, whose module is known non-root by construction and
 * whose fallback is the raw kind rather than another table — a different rule
 * that happens to read the same map.
 */
export function moduleAliasScope<A extends KindResolver, M extends KindResolver>(
  metadata: { module?: unknown } | undefined,
  aliases: A,
  aliasesByModule: ReadonlyMap<string, M> | undefined,
): A | M;
export function moduleAliasScope<A extends KindResolver, M extends KindResolver>(
  metadata: { module?: unknown } | undefined,
  aliases: A | undefined,
  aliasesByModule: ReadonlyMap<string, M> | undefined,
): A | M | undefined;
export function moduleAliasScope<A extends KindResolver, M extends KindResolver>(
  metadata: { module?: unknown } | undefined,
  aliases: A | undefined,
  aliasesByModule: ReadonlyMap<string, M> | undefined,
): A | M | undefined {
  const declaringModule = metadata?.module;
  if (typeof declaringModule !== "string") return aliases;
  return aliasesByModule?.get(declaringModule) ?? aliases;
}

/** All this rule needs of a resolver, and deliberately all it asks for:
 *  `ModuleScopes` already types its map this way so a caller can hand over a
 *  lighter table, and requiring the full `AliasResolver` here would have made
 *  the one site that does (a template body) reach for a cast. */
interface KindResolver {
  resolveKind(kind: string): string | undefined;
}

/** An empty table, shared: a non-root module with no aliases of its own resolves
 *  nothing rather than resolving through the consumer's. One instance because it
 *  is immutable in use and allocating one per call put a resolver on a per-schema
 *  loop. */
const NO_ALIASES = new AliasResolver();

/**
 * The scope a DECLARING module's own alias-form names are canonicalized in — the
 * root-aware half of the rule above, and the one that must never fall through to
 * the consumer's table. See this file's header for why the two differ.
 */
export function declaringModuleScope(
  ownModule: string | undefined,
  aliases: AliasResolver,
  scopes: { aliasesByModule: Map<string, AliasResolver>; rootModules: Set<string> },
): AliasResolver {
  const own = scopeResolverForModule(ownModule, scopes.rootModules, scopes.aliasesByModule);
  if (own) return own;
  // Root (or unknown-and-therefore-treated-as-root): the global table IS its
  // import map. A non-root module with no table of its own resolves nothing.
  return ownModule && !scopes.rootModules.has(ownModule) ? NO_ALIASES : aliases;
}

export type { ModuleScopes };
