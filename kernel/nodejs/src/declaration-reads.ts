import type { ReachSite } from "@telorun/analyzer";
import { isDeclarationReadSite, isResolvedReference } from "@telorun/analyzer";
import { getRefIdentity } from "@telorun/sdk";

/**
 * Resource → the local names it reaches ONLY through declaration-read sites
 * (every slot `use: schema`). Such a reference is answered from declarations and
 * never injected, so the holder holds nothing of the target's instance: teardown
 * orders nothing on it, while reconciliation still counts it as a read of the
 * target's declaration and re-creates the holder when the target changes.
 *
 * A cross-module reference projects onto its `Telo.Import`, whose edge stays.
 * Recorded at Phase-5 injection, the one walk over a resource's concrete sites.
 */
const reads = new WeakMap<object, ReadonlySet<string>>();

/** The local names `sites` reach at a declaration-read site and at no other. */
export function declarationOnlyNames(sites: readonly ReachSite[]): ReadonlySet<string> {
  const declared = new Set<string>();
  const held = new Set<string>();
  for (const site of sites) {
    if (site.refs.length === 0 || site.scopes.length > 0) continue;
    const ref = site.data;
    if (isResolvedReference(ref)) {
      if (ref.alias !== undefined && ref.alias !== "Self") continue;
      (isDeclarationReadSite(site) ? declared : held).add(ref.name);
    } else if (ref && typeof ref === "object") {
      // Injected on an earlier pass of the init loop.
      const injected = getRefIdentity(ref);
      if (injected) held.add(injected.name);
    }
  }
  for (const name of held) declared.delete(name);
  return declared;
}

export function recordDeclarationReads(resource: object, names: ReadonlySet<string>): void {
  if (names.size > 0) reads.set(resource, names);
  else reads.delete(resource);
}

/** The names {@link recordDeclarationReads} recorded for `resource`. */
export function declarationReadsOf(resource: unknown): ReadonlySet<string> | undefined {
  return resource && typeof resource === "object" ? reads.get(resource) : undefined;
}
