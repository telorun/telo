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
