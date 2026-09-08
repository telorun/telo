/**
 * Which `catches:` lists answer for one dispatch site.
 *
 * A catch list is one rung of a SCOPE LADDER — a route's, its router's, its
 * server's — and every rule over those lists needs the same two answers: what
 * a scope list is checked against, and which scopes enclose a given site. This
 * module owns that model; the rule checks in `validate-throws-coverage.ts` read
 * one answer instead of rebuilding it beside four unrelated jobs.
 *
 * Browser-safe: no Node built-ins.
 */
import type { DefinitionRegistry } from "./definition-registry.js";
import type { AliasResolver } from "./alias-resolver.js";
import type { ResourceManifest } from "@telorun/sdk";
import { visitManifest } from "./manifest-visitor.js";
import { forEachDrivenSlot } from "./schema-walk.js";
import { resolveRefManifest, type ResolveCtx } from "./resolve-throws-union.js";

/** What a list proves it renders: the codes its coverage-proving `when:` clauses
 *  name, and whether it ends in a catch-all.
 *
 *  Unfiltered by any denominator, because this is also what an enclosing scope
 *  contributes DOWNWARD — a server entry naming a code the server's own closure
 *  could not enumerate still renders it for the route that throws it. Filtering
 *  the local answer against the declared union happens where that answer is
 *  used, and subtracting from the declared set makes the two equivalent there. */
export interface ProvenCoverage {
  codes: Set<string>;
  hasCatchAll: boolean;
}

export const NO_COVERAGE: ProvenCoverage = { codes: new Set(), hasCatchAll: false };

/** A declaration inside another resource's `x-telo-scope` array, kept with the
 *  resource that encloses it and the path it is written at in that resource's
 *  document. Both are needed: the owner is the only place its kind's alias scope
 *  can be found, and the only document position lookup can reach. */
export interface ScopedManifest {
  manifest: ResourceManifest;
  owner: ResourceManifest;
  /** Concrete owner-relative path of the declaration (`with[0]`). */
  path: string;
}

/** Every `with:`-scoped declaration in the set, once each.
 *
 *  Scoped resources are absent from the flat manifest list, so every check that
 *  iterates it skips them — and standing a server up around a test is exactly
 *  that shape, so the sanctioned pattern was the one the pass could not see.
 *  Discovered through the shared visitor rather than a second scope walk. */
export function collectScopedManifests(
  manifests: ResourceManifest[],
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
  rootModules: Set<string>,
): ScopedManifest[] {
  const scoped: ScopedManifest[] = [];
  visitManifest(
    manifests,
    defs,
    {
      onScope: (event) => {
        for (const { manifest, path } of event.declarations) {
          if (!manifest?.kind || !manifest.metadata?.name) continue;
          scoped.push({ manifest, owner: event.source, path });
        }
      },
    },
    { aliases, aliasesByModule, rootModules },
  );
  return scoped;
}

/** Which resources each resource's scope list encloses, along the slots that
 *  declare `throwsThrough` — one fact stated once, since the edge a throws
 *  closure crosses is the edge a catch scope encloses through. */
export function buildEnclosers(
  manifests: ResourceManifest[],
  definitionOf: (m: ResourceManifest) => { schema?: Record<string, any> } | undefined,
  moduleOf: (m: ResourceManifest) => string | undefined,
  ctx: ResolveCtx,
): Map<ResourceManifest, ResourceManifest[]> {
  const enclosers = new Map<ResourceManifest, ResourceManifest[]>();
  for (const manifest of manifests) {
    const definition = definitionOf(manifest);
    if (!definition?.schema) continue;
    forEachDrivenSlot(definition.schema, manifest, (driven) => {
      if (driven.kind !== "ref" || !driven.slot.throwsThrough) return;
      const target = resolveRefManifest(driven.data, ctx, moduleOf(manifest));
      if (!target || target === manifest) return;
      const list = enclosers.get(target);
      if (list) list.push(manifest);
      else enclosers.set(target, [manifest]);
    });
  }
  return enclosers;
}

/**
 * What every scope enclosing a resource is guaranteed to render for it.
 *
 * **Across enclosers this INTERSECTS, and that is the whole correctness of the
 * reduction.** Coverage claims that a throw cannot escape unrendered, so it holds
 * only when EVERY path to the site renders it — a router mounted on a public
 * server with a catch-all and an internal one without is covered on one path and
 * bare on the other, and unioning the two reported it as fully covered while the
 * internal server answered with the built-in envelope. A resource with no
 * encloser contributes nothing rather than everything: the empty set is the
 * identity for the site's own coverage, and treating "no paths" as "all paths
 * agree" would assert coverage no list provides.
 *
 * A resource's OWN scope list is unioned in, because it applies on every path.
 *
 * Memoized, and a cycle among `throwsThrough` edges resolves to what has been
 * accumulated so far rather than raising: this answers what a scope renders, and
 * no cycle makes that answer larger.
 */
export function enclosingCoverage(
  manifest: ResourceManifest,
  ownScope: Map<ResourceManifest, ProvenCoverage>,
  enclosers: Map<ResourceManifest, ResourceManifest[]>,
  memo: Map<ResourceManifest, ProvenCoverage> = new Map(),
  walking: Set<ResourceManifest> = new Set(),
): ProvenCoverage {
  const cached = memo.get(manifest);
  if (cached) return cached;
  if (walking.has(manifest)) return NO_COVERAGE;
  walking.add(manifest);
  try {
    const own = ownScope.get(manifest);
    const result: ProvenCoverage = {
      codes: new Set(own?.codes ?? []),
      hasCatchAll: own?.hasCatchAll ?? false,
    };

    const outer = (enclosers.get(manifest) ?? []).map((e) =>
      enclosingCoverage(e, ownScope, enclosers, memo, walking),
    );
    if (outer.length > 0) {
      const [first, ...rest] = outer;
      const shared = new Set(first.codes);
      let everyCatchAll = first.hasCatchAll;
      for (const other of rest) {
        for (const code of [...shared]) if (!other.codes.has(code)) shared.delete(code);
        everyCatchAll &&= other.hasCatchAll;
      }
      for (const code of shared) result.codes.add(code);
      if (everyCatchAll) result.hasCatchAll = true;
    }

    memo.set(manifest, result);
    return result;
  } finally {
    walking.delete(manifest);
  }
}
