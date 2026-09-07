import { isRefSentinel } from "@telorun/templating";

/**
 * What a `!ref` names, parsed once.
 *
 * THE single reader of the tag's grammar, on the `ref-slot.ts` / `zone-slot.ts`
 * precedent. Three passes had grown their own parse of the same scalar and they
 * disagreed: one took the source verbatim, one split on the first dot and
 * dropped every alias but `Self`, one split on the LAST dot and dropped the
 * alias entirely — so the same `!ref Alias.name` named three different things
 * depending on which pass was asking, and the loosest of the three resolved a
 * bare name against whatever manifest happened to share it.
 *
 * The grammar itself is one line and is not in dispute: `!ref <name>` or
 * `!ref <Alias>.<name>`, split on the FIRST dot, because that is what
 * `resolveRefSentinels` does and a name may not contain one
 * (`INVALID_NAME` rejects it at every declaration site).
 *
 * What this deliberately does NOT do is decide what to look up. A reduction is
 * the caller's, and the three genuinely differ: an edge in the call graph points
 * at a cross-module target and tolerates not resolving it; a zone correlation
 * refuses to bind anything it cannot resolve exactly; a throws walk resolves in
 * the DECLARING library first. Each states its own, over one parse.
 *
 * Browser-safe.
 */
export interface RefSentinelTarget {
  /** The scalar as written, for a caller that wants the author's spelling. */
  source: string;
  /** The prefix before the first dot, `Self` included and not normalized away —
   *  a caller that treats `Self` as "no alias" says so itself. */
  alias?: string;
  /** The segment after the first dot, or the whole scalar when there is none. */
  name: string;
}

/** Parse a `!ref` sentinel. Returns `undefined` for anything that is not one —
 *  including the `{kind, name}` object `resolveRefSentinels` rewrites it into,
 *  which is a different shape with a different reader. */
export function refSentinelTarget(value: unknown): RefSentinelTarget | undefined {
  if (!isRefSentinel(value)) return undefined;
  const source = value.source;
  const dot = source.indexOf(".");
  if (dot <= 0) return { source, name: source };
  return { source, alias: source.slice(0, dot), name: source.slice(dot + 1) };
}
