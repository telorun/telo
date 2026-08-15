/** Sentinel object produced by the YAML loader for a tagged scalar (e.g. `!cel
 *  'variables.port'`). Travels through the manifest tree as the parsed value;
 *  precompile and the analyzer key off `__tagged === true` to dispatch to the
 *  right engine. The object is intentionally a plain JSON-shaped record so it
 *  survives `Document.toJSON()` and `JSON.parse(JSON.stringify(...))` without
 *  loss. */
export interface TaggedSentinel {
  readonly __tagged: true;
  readonly engine: string;
  readonly source: string;
}

export function isTaggedSentinel(v: unknown): v is TaggedSentinel {
  return (
    v !== null &&
    typeof v === "object" &&
    (v as { __tagged?: unknown }).__tagged === true &&
    typeof (v as { engine?: unknown }).engine === "string" &&
    typeof (v as { source?: unknown }).source === "string"
  );
}

export function makeTaggedSentinel(engine: string, source: string): TaggedSentinel {
  return { __tagged: true, engine, source };
}

/** True when `v` is a `!ref <name>` sentinel — i.e. a resource reference
 *  marked at parse time. Downstream walkers (analyzer ref validation,
 *  inline normalization, dependency graph, kernel resource resolution)
 *  use this to tell a reference from an inline definition without
 *  inferring intent from field presence. */
export function isRefSentinel(v: unknown): v is TaggedSentinel & { engine: "ref" } {
  return isTaggedSentinel(v) && v.engine === "ref";
}

/** The CEL engine's name. Beside the other sentinel predicates for the same
 *  reason they are: a consumer that spells an engine name inline is a second
 *  place the registry's key is written down. */
export const CEL_ENGINE = "cel";

/** Engine names of the two file-embedding tags. Named here beside the other
 *  sentinel predicates so the kernel's resolution pass and the engines
 *  themselves agree on one spelling. */
export const INCLUDE_TEXT_ENGINE = "include-text";
export const INCLUDE_BYTES_ENGINE = "include-bytes";

/**
 * The dotted chain a value names, or undefined.
 *
 * Only a PLAIN CHAIN — `steps.encode.result.output` — in either spelling a
 * manifest may carry it: a `!cel` sentinel or the `${{ }}` string form. An
 * expression that COMPUTES rather than names has no schema to read off a context,
 * so a caller that navigates one gets nothing and reports nothing: silence where
 * the analyzer knows least is the conservative direction.
 *
 * Here rather than in each caller because "is this expression a plain chain" is
 * one question, and two copies of the answer would eventually disagree about a
 * shape like `a.b[0]`.
 */
export function plainChainOf(value: unknown): string | undefined {
  const source = isTaggedSentinel(value)
    ? value.engine === CEL_ENGINE
      ? value.source
      : undefined
    : typeof value === "string"
      ? /^\s*\$\{\{(.+)\}\}\s*$/.exec(value)?.[1]
      : undefined;
  if (typeof source !== "string") return undefined;
  const trimmed = source.trim();
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(trimmed)
    ? trimmed
    : undefined;
}

/** Both file-embedding tag names, for a consumer holding an engine NAME rather
 *  than a value (the analyzer's expression walk reports names). */
export const INCLUDE_ENGINE_NAMES: ReadonlySet<string> = new Set([
  INCLUDE_TEXT_ENGINE,
  INCLUDE_BYTES_ENGINE,
]);

/** True when `v` is an `!include-text` / `!include-bytes` sentinel — a file
 *  embed marked at parse time and still unresolved.
 *
 *  The kernel's creation-time resolution keys off this the way Phase-5
 *  injection keys off {@link isRefSentinel}. Both tags survive precompile as
 *  markers rather than collapsing to a value, because the read is deferred: a
 *  manifest load must not pull payload layers, and the analyzer that types the
 *  slot cannot open files at all. */
export function isIncludeSentinel(
  v: unknown,
): v is TaggedSentinel & { engine: typeof INCLUDE_TEXT_ENGINE | typeof INCLUDE_BYTES_ENGINE } {
  return (
    isTaggedSentinel(v) && (v.engine === INCLUDE_TEXT_ENGINE || v.engine === INCLUDE_BYTES_ENGINE)
  );
}
