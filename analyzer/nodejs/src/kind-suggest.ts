import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { distance } from "./levenshtein.js";

/** User-facing root kinds that are always legal regardless of imports. */
const ROOT_KINDS = [
  "Telo.Application",
  "Telo.Library",
  "Telo.Import",
  "Telo.Definition",
] as const;

/** Definition kinds that are not user-instantiable and should be excluded
 *  from completion / suggestion lists. */
const ABSTRACT_DEF_KINDS = new Set(["Telo.Abstract", "Telo.Template"]);

/** Computes the set of user-facing kind strings available in the given
 *  (aliases, defs) context:
 *    - The hardcoded Telo root kinds.
 *    - For every registered non-abstract definition, the alias form
 *      `${alias}.${TypeName}` for each import alias that points at its
 *      module. Canonical kebab-case forms (e.g. `http-server.Server`) are
 *      deliberately excluded — users write manifests via alias. */
export function computeValidUserFacingKinds(
  aliases: AliasResolver,
  defs: DefinitionRegistry,
): string[] {
  const out = new Set<string>(ROOT_KINDS);

  for (const kind of defs.kinds()) {
    const def = defs.resolve(kind);
    if (!def || ABSTRACT_DEF_KINDS.has(def.kind)) continue;

    const dot = kind.indexOf(".");
    if (dot === -1) continue;
    const moduleName = kind.slice(0, dot);
    const typeName = kind.slice(dot + 1);

    for (const alias of aliases.aliasesFor(moduleName)) {
      out.add(`${alias}.${typeName}`);
    }
  }

  return Array.from(out);
}

/** Returns the closest user-facing kind to `badKind` within an edit-distance
 *  threshold, or undefined when nothing close enough exists (including ties).
 *  Case-sensitive — kinds are PascalCase by contract. */
export function computeSuggestKind(
  badKind: string,
  aliases: AliasResolver,
  defs: DefinitionRegistry,
): string | undefined {
  if (!badKind) return undefined;
  const candidates = computeValidUserFacingKinds(aliases, defs);
  const threshold = Math.min(3, Math.floor(badKind.length / 3));
  if (threshold < 1) return undefined;

  let best: string | undefined;
  let bestDist = threshold + 1;
  let tied = false;

  for (const c of candidates) {
    const d = distance(badKind, c);
    if (d < bestDist) {
      best = c;
      bestDist = d;
      tied = false;
    } else if (d === bestDist) {
      tied = true;
    }
  }

  if (!best || bestDist > threshold || tied) return undefined;
  return best;
}
