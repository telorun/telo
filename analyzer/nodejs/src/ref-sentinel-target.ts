import { isRefSentinel, parseRefSource, type RefIndex, type RefRefusal, type RefVerdict } from "@telorun/templating";

/**
 * What a `!ref` names, as the `!ref` engine's verdict says.
 *
 * The grammar is the engine's (`parseRefSource`, templating): the loader parses
 * the text once and attaches `parsed` or `refusal` to the sentinel, and this
 * adapter is how the analyzer reads that verdict — it keeps no grammar of its
 * own. Three passes once parsed the scalar each their own way and disagreed
 * about `!ref Alias.name`, which is why there is one reading.
 *
 * What this deliberately does NOT do is decide what to look up. A reduction is
 * the caller's, and they genuinely differ: an edge in the call graph points at
 * a cross-module target and tolerates not resolving it; a zone correlation
 * refuses to bind anything it cannot resolve exactly; a throws walk resolves in
 * the DECLARING library first. Each states its own, over one parse.
 *
 * Browser-safe.
 */
export interface RefSentinelTarget {
  /** The scalar as written, for a caller that wants the author's spelling. */
  source: string;
  /** The import alias as written, `Self` included and not normalized away — a
   *  caller that treats `Self` as "no alias" says so itself. */
  alias?: string;
  /** The name the reference resolves, or a family's name when indexed. */
  name: string;
  /** A family member's `[<binding>.key|index]`, in written order; empty for a
   *  plain reference. */
  indexes: readonly RefIndex[];
}

/** True when `text` is a plain `!ref` text — `<name>` or `<Alias>.<name>` — so
 *  a repair can write it behind the tag verbatim. Asked of the engine. */
export function isRefSourceSpelling(text: string): boolean {
  const verdict = parseRefSource(text);
  return "parsed" in verdict && verdict.parsed.indexes.length === 0;
}

/** Read a `!ref` sentinel. Returns `undefined` for anything that is not one,
 *  for one whose text the grammar refuses ({@link refSentinelRefusal}), and for
 *  the `{kind, name}` object `resolveRefSentinels` rewrites it into, which is a
 *  different shape with a different reader. */
export function refSentinelTarget(value: unknown): RefSentinelTarget | undefined {
  if (!isRefSentinel(value)) return undefined;
  const verdict = verdictOf(value);
  if (!verdict || !("parsed" in verdict)) return undefined;
  const { parsed } = verdict;
  return {
    source: value.source,
    ...(parsed.alias !== undefined ? { alias: parsed.alias } : {}),
    name: parsed.name,
    indexes: parsed.indexes,
  };
}

/** The refusal of a `!ref` sentinel whose text is outside the grammar. */
export function refSentinelRefusal(value: unknown): RefRefusal | undefined {
  const verdict = verdictOf(value);
  return verdict && "refusal" in verdict ? verdict.refusal : undefined;
}

/** The verdict a sentinel carries — or, for one built by hand rather than by
 *  the loader, the engine's verdict on its text. */
function verdictOf(value: unknown): RefVerdict | undefined {
  if (!isRefSentinel(value)) return undefined;
  if (value.parsed) return { parsed: value.parsed };
  if (value.refusal) return { refusal: value.refusal };
  return parseRefSource(value.source);
}

/** The local name a `!ref` sentinel names — its name for `<name>` and
 *  `Self.<name>` — or its text as written for anything else (an alias-qualified
 *  name, a text the grammar refuses), which names no local declaration. */
export function localRefName(value: unknown): string {
  const target = refSentinelTarget(value);
  if (target && (target.alias === undefined || target.alias === "Self")) return target.name;
  return isRefSentinel(value) ? value.source : "";
}
