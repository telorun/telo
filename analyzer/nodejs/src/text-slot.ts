/**
 * The built-in text vocabulary's single reader — the `ref-slot.ts` / `step-slot.ts`
 * precedent.
 *
 * Three fragments mark where text shown to a person is written:
 *
 * - `telo://manifest#/$defs/Message` — a pattern, or a plural selection;
 * - `telo://manifest#/$defs/Text` — a Message, or `{ text: Message, context }`;
 * - `telo://manifest#/$defs/TextCatalog` — `{ lang, texts: [{ text, context?, translation }] }`.
 *
 * Each is recognised by the `x-telo-fragment` stamp fragment expansion leaves on the
 * slot, never by a field name. Two annotations ride beside them:
 *
 * - `x-telo-text-context: "<context>"` on a DATA schema node — the context of that
 *   node's `title`, `description` and enum labels;
 * - `x-telo-text-values-for: "<JSON Pointer>"` on the node holding a message's
 *   values — the `Text` they bind, relative to the enclosing value (the object
 *   holding the annotated field; for a callable parameter, the argument record
 *   keyed by parameter name).
 *
 * - `x-telo-text-values: { <name>: <schema> }` on a `Text` / `Message` node — the
 *   values its reader formats it with (`{}` for none), so a placeholder no reader
 *   binds is refused where the text is written.
 *
 * A fourth fragment, `telo://manifest#/$defs/TextRecord`, types a text as a
 * controller already received it; it is opaque here — the walk never enters one.
 *
 * Both halves read this file: `telo check` walks literals, the kernel walks the
 * values a resource is created with. Browser-safe: no Node built-ins.
 */
import { manifestFragmentOf } from "./manifest-schemas.js";
import { resolveSchemaPointer } from "./manifest-navigation.js";

export const MESSAGE_FRAGMENT = "Message";
export const TEXT_FRAGMENT = "Text";
export const TEXT_CATALOG_FRAGMENT = "TextCatalog";
export const TEXT_CONTEXT_ANNOTATION = "x-telo-text-context";
export const TEXT_VALUES_FOR_ANNOTATION = "x-telo-text-values-for";
export const TEXT_VALUES_ANNOTATION = "x-telo-text-values";
export const TEXT_RECORD_FRAGMENT = "TextRecord";

/** The language a module writes in when it declares no `lang:`. */
export const UNDETERMINED_LANGUAGE = "und";

/** What each annotation's value must be, as JSON Schema — the data-schema
 *  annotation vocabulary's entries, validated where each annotation is read. */
export const TEXT_ANNOTATION_VALUE_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = {
  [TEXT_CONTEXT_ANNOTATION]: { type: "string", minLength: 1 },
  [TEXT_VALUES_FOR_ANNOTATION]: { type: "string", pattern: "^/" },
};

export type TextFragment = typeof MESSAGE_FRAGMENT | typeof TEXT_FRAGMENT | typeof TEXT_CATALOG_FRAGMENT;

/** The text fragment a schema node is stamped with, or undefined. */
export function textFragmentOf(schema: unknown): TextFragment | undefined {
  const name = manifestFragmentOf(schema);
  return name === MESSAGE_FRAGMENT || name === TEXT_FRAGMENT || name === TEXT_CATALOG_FRAGMENT
    ? name
    : undefined;
}

/** True when `schema` is a `TextRecord` slot: opaque to every text walk. */
export function isTextRecordSchema(schema: unknown): boolean {
  return manifestFragmentOf(schema) === TEXT_RECORD_FRAGMENT;
}

/** True when `schema` is a slot typed by the `Text` fragment. */
export function isTextSchema(schema: unknown): boolean {
  return textFragmentOf(schema) === TEXT_FRAGMENT;
}

/** A path into a value: property names and array indices. */
export type ValuePath = readonly (string | number)[];

/** `a.b[0].c` — the spelling `data.path` and every kernel message use. */
export function renderValuePath(path: ValuePath): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? segment : `.${segment}`;
  }
  return out;
}

/** One place a resource holds text of a text fragment. */
export interface TextSite {
  readonly fragment: TextFragment;
  readonly path: ValuePath;
  readonly value: unknown;
  /** What `x-telo-text-values` declares at the slot: the values its reader
   *  formats the text with. Absent when the slot declares nothing. */
  readonly declaredValues?: Readonly<Record<string, unknown>>;
}

/** One node holding a message's values, paired with the text it names. */
export interface TextValuesSite {
  /** Where the values are. */
  readonly path: ValuePath;
  readonly values: unknown;
  /** Where the paired text is, and what it holds. */
  readonly textPath: ValuePath;
  readonly text: unknown;
}

export interface TextWalkOptions {
  /** True for a value only known once evaluated (a tag in the analyzer, a compiled
   *  value in the kernel). The walk records it at a site and descends no further. */
  readonly isExpression: (value: unknown) => boolean;
  /** Resolves a non-local `$ref` (a named shape) to the shape and the document its
   *  own `#…` references resolve against. */
  readonly resolveRef?: (ref: string) => { schema: Record<string, any>; root: Record<string, any> } | undefined;
}

/** An expression met where text may lie beneath it: what it produces is text-bearing
 *  data typed by `schema`, whose `#…` references resolve against `root`. */
export interface TextExpressionSite {
  readonly path: ValuePath;
  readonly schema: Record<string, any>;
  readonly root: Record<string, any>;
}

export interface TextWalk {
  readonly texts: TextSite[];
  readonly values: TextValuesSite[];
  /** Expressions above a text site or a values pairing, by the schema node each
   *  fills — one per node, so a path a union reaches twice is listed twice. */
  readonly expressions: TextExpressionSite[];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const declaring = new WeakMap<object, WeakMap<object, boolean>>();

/** True when `schema` reaches a text fragment or a values pairing anywhere — its
 *  `#…` references followed against `root`, a named shape assumed to — asked
 *  before a value is walked, since most kinds hold no text. Memoized. */
function declaresText(schema: Record<string, any>, root: Record<string, any> = schema): boolean {
  let byNode = declaring.get(root);
  if (!byNode) declaring.set(root, (byNode = new WeakMap()));
  let known = byNode.get(schema);
  if (known === undefined) {
    const seen = new Set<object>();
    const scan = (node: unknown): boolean => {
      if (!node || typeof node !== "object" || seen.has(node)) return false;
      seen.add(node);
      if (Array.isArray(node)) return node.some(scan);
      if (isTextRecordSchema(node)) return false;
      if (textFragmentOf(node) !== undefined || TEXT_VALUES_FOR_ANNOTATION in node) return true;
      const ref = (node as Record<string, unknown>).$ref;
      if (typeof ref === "string") {
        if (!ref.startsWith("#")) return true;
        if (scan(resolveSchemaPointer(root, ref))) return true;
      }
      return Object.values(node).some(scan);
    };
    byNode.set(schema, (known = scan(schema)));
  }
  return known;
}

/** The pointer's segments, or undefined for a value that is no JSON Pointer. */
export function pointerSegments(pointer: unknown): string[] | undefined {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) return undefined;
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** The values `x-telo-text-values` declares on a node, when it holds a map. */
export function declaredTextValuesOf(schema: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isPlainObject(schema)) return undefined;
  const declared = schema[TEXT_VALUES_ANNOTATION];
  return isPlainObject(declared) ? declared : undefined;
}

/**
 * Whether a text fragment's schema admits `value` — judged from the fragment's
 * own data, never from a name: a string where a branch is a string, an object
 * only when it holds every required member of one closed object branch and no
 * member outside it. A value the fragment does not admit is no text site, so a
 * slot that is one alternative of a union beside an object shape (a text-with-values object)
 * leaves that shape to its own branch.
 */
export function fragmentAdmits(
  fragmentNode: Record<string, any>,
  value: unknown,
  root: Record<string, any>,
  resolveRef?: TextWalkOptions["resolveRef"],
): boolean {
  if (typeof value !== "string" && !isPlainObject(value)) return false;
  const keys = isPlainObject(value) ? Object.keys(value) : [];
  const seen = new Set<object>();
  const admits = (node: unknown, at: Record<string, any>): boolean => {
    if (!isPlainObject(node) || seen.has(node)) return false;
    seen.add(node);
    if (typeof node.$ref === "string") {
      if (node.$ref.startsWith("#")) {
        if (admits(resolveSchemaPointer(at, node.$ref), at)) return true;
      } else {
        const named = resolveRef?.(node.$ref);
        if (named && admits(named.schema, named.root)) return true;
      }
    }
    for (const union of ["anyOf", "oneOf"] as const) {
      if (Array.isArray(node[union]) && node[union].some((branch: unknown) => admits(branch, at))) return true;
    }
    const types = node.type === undefined ? [] : [node.type].flat();
    if (typeof value === "string") return types.includes("string");
    if (!types.includes("object")) return false;
    const properties = isPlainObject(node.properties) ? node.properties : {};
    const required: unknown[] = Array.isArray(node.required) ? node.required : [];
    if (!required.every((name) => typeof name === "string" && keys.includes(name))) return false;
    return node.additionalProperties !== false || keys.every((key) => key in properties);
  };
  return admits(fragmentNode, root);
}

/** Members of a resource's own value that its kind's schema never declares. */
const RESOURCE_ENVELOPE = new Set(["kind", "metadata"]);

/**
 * Whether a union branch definitely cannot hold `value`, a plain object: the
 * branch — or a schema it references, an `allOf` member, or every alternative of
 * a union it holds — requires a member the value lacks, or is closed and the
 * value holds a member it neither declares nor matches by pattern. Any doubt
 * keeps the branch: a reference that does not resolve says nothing. At a
 * resource's root the value carries `kind` and `metadata`, which no branch
 * declares, so they never count as extra.
 */
function branchExcludes(
  branch: unknown,
  root: Record<string, any>,
  value: unknown,
  path: ValuePath,
  resolveRef: TextWalkOptions["resolveRef"],
): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).filter((key) => path.length > 0 || !RESOURCE_ENVELOPE.has(key));
  const ancestry = new Set<object>();
  const excludes = (node: unknown, at: Record<string, any>): boolean => {
    if (!isPlainObject(node) || ancestry.has(node)) return false;
    ancestry.add(node);
    try {
      if (typeof node.$ref === "string") {
        const target = node.$ref.startsWith("#")
          ? { schema: resolveSchemaPointer(at, node.$ref), root: at }
          : resolveRef?.(node.$ref);
        if (target && excludes(target.schema, target.root)) return true;
      }
      const required: unknown[] = Array.isArray(node.required) ? node.required : [];
      if (required.some((name) => typeof name === "string" && !Object.hasOwn(value, name))) return true;
      if (node.additionalProperties === false) {
        const properties = isPlainObject(node.properties) ? node.properties : {};
        const patterns = isPlainObject(node.patternProperties) ? Object.keys(node.patternProperties) : [];
        const extra = keys.some(
          (key) => !Object.hasOwn(properties, key) && !patterns.some((pattern) => safeRegExp(pattern)?.test(key)),
        );
        if (extra) return true;
      }
      if (Array.isArray(node.allOf) && node.allOf.some((member: unknown) => excludes(member, at))) return true;
      for (const union of ["anyOf", "oneOf"] as const) {
        const alternatives = node[union];
        if (Array.isArray(alternatives) && alternatives.length > 0) {
          if (alternatives.every((alternative: unknown) => excludes(alternative, at))) return true;
        }
      }
      return false;
    } finally {
      ancestry.delete(node);
    }
  };
  return excludes(branch, root);
}

/**
 * Every text site and every values pairing `data` holds, found by walking `schema`
 * and the value in tandem: through `properties`, a map's `additionalProperties` /
 * `patternProperties`, a list's `items`, every `allOf` member and each `oneOf` /
 * `anyOf` branch the value can hold (never one it definitely cannot), a
 * document-local `$ref` (resolved against `root`, the document `schema` lies in),
 * and a named shape through `resolveRef`. A site is not descended into, and
 * neither is an expression — listed instead when text may lie beneath it — a
 * non-plain value (a live instance) or a value no branch declares.
 */
export function textSites(
  schema: Record<string, any>,
  data: unknown,
  options: TextWalkOptions,
  root: Record<string, any> = schema,
): TextWalk {
  const texts = new Map<string, TextSite>();
  const values = new Map<string, TextValuesSite>();
  const expressions: TextExpressionSite[] = [];
  if (!declaresText(schema, root)) return { texts: [], values: [], expressions };
  const entered = new Set<string>();
  const ids = new WeakMap<object, number>();
  let nextId = 0;
  const nodeId = (node: object) => {
    let id = ids.get(node);
    if (id === undefined) ids.set(node, (id = nextId++));
    return id;
  };

  const walk = (
    node: unknown,
    root: Record<string, any>,
    value: unknown,
    path: ValuePath,
    holder: { value: Record<string, unknown>; path: ValuePath } | undefined,
    inheritedValues?: Readonly<Record<string, unknown>>,
  ): void => {
    if (!node || typeof node !== "object" || Array.isArray(node) || value === undefined) return;
    const declared = node as Record<string, any>;
    const key = `${nodeId(declared)}\0${renderValuePath(path)}`;
    if (entered.has(key)) return;
    entered.add(key);

    if (isTextRecordSchema(declared)) return;
    const fragment = textFragmentOf(declared);
    if (fragment !== undefined) {
      const at = renderValuePath(path);
      const admitted =
        options.isExpression(value) ||
        fragmentAdmits(declared, path.length === 0 ? siteValueOf({ path, value }) : value, root, options.resolveRef);
      if (admitted && !texts.has(at)) {
        const declaredValues = declaredTextValuesOf(declared) ?? inheritedValues;
        texts.set(at, { fragment, path, value, ...(declaredValues ? { declaredValues } : {}) });
      }
      return;
    }
    const pairing = pointerSegments(declared[TEXT_VALUES_FOR_ANNOTATION]);
    if (pairing && holder && !values.has(renderValuePath(path))) {
      let text: unknown = holder.value;
      for (const segment of pairing) text = isPlainObject(text) ? text[segment] : undefined;
      values.set(renderValuePath(path), {
        path,
        values: value,
        textPath: [...holder.path, ...pairing],
        text,
      });
    }
    if (options.isExpression(value)) {
      if (declaresText(declared, root)) expressions.push({ path, schema: declared, root });
      return;
    }

    if (typeof declared.$ref === "string") {
      const carried = declaredTextValuesOf(declared) ?? inheritedValues;
      if (declared.$ref.startsWith("#")) {
        walk(resolveSchemaPointer(root, declared.$ref), root, value, path, holder, carried);
      } else {
        const named = options.resolveRef?.(declared.$ref);
        if (named) walk(named.schema, named.root, value, path, holder, carried);
      }
    }
    for (const union of ["oneOf", "anyOf", "allOf"] as const) {
      if (Array.isArray(declared[union])) {
        for (const branch of declared[union]) {
          if (union !== "allOf" && branchExcludes(branch, root, value, path, options.resolveRef)) continue;
          walk(branch, root, value, path, holder);
        }
      }
    }
    if (Array.isArray(value)) {
      if (declared.items && typeof declared.items === "object" && !Array.isArray(declared.items)) {
        value.forEach((item, index) => walk(declared.items, root, item, [...path, index], holder));
      }
      return;
    }
    if (!isPlainObject(value)) return;
    const properties = isPlainObject(declared.properties) ? declared.properties : {};
    const patterns = isPlainObject(declared.patternProperties) ? declared.patternProperties : {};
    const here = { value, path };
    for (const [name, child] of Object.entries(value)) {
      const childPath = [...path, name];
      if (name in properties) {
        walk(properties[name], root, child, childPath, here);
        continue;
      }
      let matched = false;
      for (const [pattern, patternSchema] of Object.entries(patterns)) {
        if (safeRegExp(pattern)?.test(name)) {
          matched = true;
          walk(patternSchema, root, child, childPath, here);
        }
      }
      if (!matched && declared.additionalProperties && typeof declared.additionalProperties === "object") {
        walk(declared.additionalProperties, root, child, childPath, here);
      }
    }
  };
  walk(schema, root, data, [], undefined);
  return { texts: [...texts.values()], values: [...values.values()], expressions };
}

/** What a text site holds as its fragment's value: at a resource's root — a kind
 *  whose whole schema is the fragment — what its author wrote beside `kind` and
 *  `metadata`. */
export function siteValueOf(site: Pick<TextSite, "path" | "value">): unknown {
  if (site.path.length > 0 || !isPlainObject(site.value)) return site.value;
  const { kind, metadata, ...fields } = site.value;
  return fields;
}

const reachingCatalog = new WeakMap<object, WeakMap<object, boolean>>();

/** True when `schema` reaches the `TextCatalog` fragment — its `#…` references
 *  followed against `root`, a named shape through `resolveRef`. Memoized. */
function reachesTextCatalog(
  schema: Record<string, any>,
  root: Record<string, any>,
  resolveRef: TextWalkOptions["resolveRef"],
): boolean {
  let byNode = reachingCatalog.get(root);
  if (!byNode) reachingCatalog.set(root, (byNode = new WeakMap()));
  let known = byNode.get(schema);
  if (known === undefined) {
    const seen = new Set<object>();
    const scan = (node: unknown, at: Record<string, any>): boolean => {
      if (!node || typeof node !== "object" || seen.has(node)) return false;
      seen.add(node);
      if (Array.isArray(node)) return node.some((item) => scan(item, at));
      if (textFragmentOf(node) === TEXT_CATALOG_FRAGMENT) return true;
      const ref = (node as Record<string, unknown>).$ref;
      if (typeof ref === "string") {
        if (ref.startsWith("#")) {
          if (scan(resolveSchemaPointer(at, ref), at)) return true;
        } else {
          const named = resolveRef?.(ref);
          if (named && scan(named.schema, named.root)) return true;
        }
      }
      return Object.values(node).some((child) => scan(child, at));
    };
    byNode.set(schema, (known = scan(schema, root)));
  }
  return known;
}

/** Where an expression stands ABOVE a `TextCatalog` slot: a catalog it produced
 *  would be computed, which a catalog never is. One at the slot is the catalog's
 *  own judgement's. Each path once, in walk order. */
export function catalogsComputedAbove(walk: TextWalk, options: TextWalkOptions): ValuePath[] {
  const out = new Map<string, ValuePath>();
  for (const expression of walk.expressions) {
    const at = renderValuePath(expression.path);
    if (!out.has(at) && reachesTextCatalog(expression.schema, expression.root, options.resolveRef)) {
      out.set(at, expression.path);
    }
  }
  return [...out.values()];
}

const patternCache = new Map<string, RegExp | null>();

/** A `patternProperties` key compiled, or null for one that does not compile. */
export function safeRegExp(pattern: string): RegExp | null {
  let compiled = patternCache.get(pattern);
  if (compiled === undefined) {
    try {
      compiled = new RegExp(pattern, "u");
    } catch {
      // An unreadable `patternProperties` key is the schema's own defect, which
      // schema validation reports; here it matches nothing.
      compiled = null;
    }
    patternCache.set(pattern, compiled);
  }
  return compiled;
}

/** Every value inside `value` that `isExpression` holds, with its path below it —
 *  plain containers only. */
export function expressionsWithin(
  value: unknown,
  isExpression: (value: unknown) => boolean,
  path: ValuePath = [],
): { path: ValuePath; value: unknown }[] {
  if (isExpression(value)) return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => expressionsWithin(item, isExpression, [...path, index]));
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([key, child]) => expressionsWithin(child, isExpression, [...path, key]));
  }
  return [];
}
