import {
  isMap,
  isScalar,
  isSeq,
  visit,
  YAMLMap,
  type CollectionTag,
  type Document,
  type Node,
  type Schema,
} from "yaml";
import { createPair, type CreateNodeContext, type ToJSContext } from "yaml/util";

/**
 * The expansion tags — `!if`, `!switch`, `!for-each` — a closed tag family beside
 * the expression engines and outside their contract. Each sits on a mapping and
 * loads as that same mapping, its keys in written order after the marker
 * {@link EXPANSION_MARKER} naming the tag. Position travels by path, so a key
 * inside a branch (`cases.postgres.<typo>`) is a path in the loaded tree as in
 * the YAML.
 */
export const EXPANSION_TAGS = ["if", "switch", "for-each"] as const;
export type ExpansionTag = (typeof EXPANSION_TAGS)[number];

/** The key a loaded expansion mapping carries its tag under. */
export const EXPANSION_MARKER = "__expand";

/** The mapping key that splices a `!for-each`'s entries into its mapping. A
 *  plain key to every loader; its meaning is the analyzer's. */
export const SPLICE_KEY = "...";

/** An expansion tag's mapping as loaded: the marker plus the written keys. */
export type ExpansionSentinel = { readonly [EXPANSION_MARKER]: ExpansionTag } & Record<
  string,
  unknown
>;

export function isExpansionTag(name: unknown): name is ExpansionTag {
  return typeof name === "string" && (EXPANSION_TAGS as readonly string[]).includes(name);
}

/** True when `v` is a loaded expansion mapping — a plain object carrying the
 *  marker with one of the three tag names. */
export function isExpansionSentinel(v: unknown): v is ExpansionSentinel {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    isExpansionTag((v as Record<string, unknown>)[EXPANSION_MARKER])
  );
}

/** The tag a value was written behind, or undefined. */
export function expansionTagOf(v: unknown): ExpansionTag | undefined {
  return isExpansionSentinel(v) ? v[EXPANSION_MARKER] : undefined;
}

/** The tag as written (`!if`) of an expansion mapping, or undefined. */
export function expansionTagLabel(v: unknown): string | undefined {
  const tag = expansionTagOf(v);
  return tag ? `!${tag}` : undefined;
}

/** The written keys of an expansion mapping, marker removed, in written order. */
export function expansionBody(v: ExpansionSentinel): Record<string, unknown> {
  return Object.fromEntries(Object.entries(v).filter(([key]) => key !== EXPANSION_MARKER));
}

/** The code a shape refusal of `tag` is reported under. */
export function expansionShapeCode(tag: ExpansionTag): "BRANCH_SHAPE_INVALID" | "REPEAT_SHAPE_INVALID" {
  return tag === "for-each" ? "REPEAT_SHAPE_INVALID" : "BRANCH_SHAPE_INVALID";
}

function expansionMapClass(tag: ExpansionTag): {
  new (schema?: Schema): YAMLMap;
  from(schema: Schema, obj: unknown, ctx: CreateNodeContext): YAMLMap;
} {
  return class ExpansionMap extends YAMLMap {
    // The marker first, then the written keys: the order both loaders produce.
    override toJSON(_?: unknown, ctx?: ToJSContext, Type?: { new (): unknown }): any {
      const loaded = super.toJSON(_, ctx, Type as never) as Record<string, unknown> | Map<unknown, unknown>;
      if (loaded instanceof Map) {
        return new Map<unknown, unknown>([[EXPANSION_MARKER, tag], ...loaded]);
      }
      return { [EXPANSION_MARKER]: tag, ...loaded };
    }

    // A node built from a loaded mapping writes `metadata` first, then every
    // other written key, and never the marker.
    static override from(schema: Schema, obj: unknown, ctx: CreateNodeContext): YAMLMap {
      const map = new this(schema);
      const body = isExpansionSentinel(obj) ? expansionBody(obj) : (obj as Record<string, unknown>);
      const keys = Object.keys(body);
      const ordered = keys.includes("metadata")
        ? ["metadata", ...keys.filter((k) => k !== "metadata")]
        : keys;
      for (const key of ordered) {
        const value = body[key];
        if (value !== undefined || ctx.keepUndefined) map.items.push(createPair(key, value, ctx));
      }
      return map;
    }
  };
}

/** The `customTags` entries of the expansion tags: one mapping tag each, whose
 *  node class loads the mapping with its marker and writes it back behind its
 *  tag. */
export function buildExpansionTags(): CollectionTag[] {
  return EXPANSION_TAGS.map((tag) => {
    const nodeClass = expansionMapClass(tag);
    return {
      tag: `!${tag}`,
      collection: "map",
      nodeClass,
      identify: (v: unknown) => expansionTagOf(v) === tag,
      createNode: (schema: Schema, value: unknown, ctx: CreateNodeContext) =>
        nodeClass.from(schema, value, ctx),
    } satisfies CollectionTag;
  });
}

/** An expansion tag the YAML itself refuses: one written on a scalar or a
 *  sequence, or a tagged mapping writing the marker key itself. */
export interface ExpansionTagMisuse {
  readonly tag: ExpansionTag;
  readonly code: "BRANCH_SHAPE_INVALID" | "REPEAT_SHAPE_INVALID";
  readonly message: string;
  /** The node's character range in the parsed text, `[start, end]`. */
  readonly range?: readonly [number, number];
}

/** Every misuse of an expansion tag in one parsed document — what no loaded
 *  tree can show, since a tag on a scalar or a sequence loads as the bare
 *  value. Reported at load by every loader. */
export function expansionTagMisuse(document: Document): ExpansionTagMisuse[] {
  const found: ExpansionTagMisuse[] = [];
  const report = (node: Node, tag: ExpansionTag, message: string) => {
    found.push({
      tag,
      code: expansionShapeCode(tag),
      message,
      ...(node.range ? { range: [node.range[0], node.range[1]] as const } : {}),
    });
  };
  visit(document, (_key, node) => {
    if (!isScalar(node) && !isSeq(node) && !isMap(node)) return;
    const name = node.tag?.startsWith("!") ? node.tag.slice(1) : undefined;
    if (!isExpansionTag(name)) return;
    if (isMap(node)) {
      const markerKey = node.items.find(
        (pair) => isScalar(pair.key) && pair.key.value === EXPANSION_MARKER,
      );
      if (markerKey) {
        report(
          node,
          name,
          `'!${name}' holds a key '${EXPANSION_MARKER}', which is reserved for the tag's own marker. Remove it.`,
        );
      }
      return;
    }
    report(
      node,
      name,
      `'!${name}' is written on ${isSeq(node) ? "a sequence" : "a scalar"}; it takes a mapping ` +
        `(${name === "for-each" ? "'{ in, as?, emit }'" : name === "if" ? "'{ if, then, else? }'" : "'{ switch, cases, default? }'"}).`,
    );
  });
  return found;
}
