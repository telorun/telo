/**
 * The value/schema positional co-walk: a value and the schema typing it, walked in
 * tandem, each schema node reaching each position reported to a READER. One walk,
 * several readers — the text sites (`text-slot.ts`), the schema sites
 * (`text-schemas.ts`) — so what "the schema at this position" means is decided
 * once.
 *
 * The walk goes through `properties`, every `patternProperties` entry a key
 * matches (`additionalProperties` — an object schema — when none does), a list's
 * `items`, every `allOf` member and EVERY `oneOf` / `anyOf` branch — never
 * pruned: a branch that definitely cannot hold the value is visited with
 * `excluded` set, sticky beneath it, and a reader that wants only the branches
 * the value can hold stops there. A `#…` `$ref` resolves against the document
 * the node lies in, a named shape through the reader's `resolveRef`.
 *
 * The reader decides, never the walk:
 * - `reaches` — whether a schema can reach what the reader looks for at all
 *   (memoize it with {@link schemaReachGate}); a schema it cannot is not walked;
 * - `standing` — the values standing at a position: the value itself, none (a
 *   boundary — a value only known once evaluated, which `visit` still sees and
 *   which is never descended), or values walked in its place at the same schema
 *   node, each at its own path;
 * - `visit` — every node at every position, once per node, path and exclusion;
 *   returning `"stop"` claims the node and everything beneath it;
 * - `referenceSlot` — a node carrying `x-telo-ref`: reported, never descended;
 * - `residualKeys` — per object value, the keys no node reaching it types
 *   (below).
 *
 * **Residual keys** count every node visited at the object's position, excluded
 * branches included: a node's `properties`, its `patternProperties` and an
 * object (or `true`) `additionalProperties` type their keys; a node that does not
 * close (`additionalProperties: false`) types every key, unless it only combines
 * others (`$ref` / `allOf` / `anyOf` / `oneOf`, with no object keyword of its own)
 * or its `type` excludes `object`; a `$ref` that does not resolve, a node a reader
 * stops at, a reference slot and a boundary type every key. At a resource's root
 * `kind` and `metadata` are always typed.
 *
 * Browser-safe: no Node built-ins.
 */
import { readRefSlot, type RefSlot } from "./ref-slot.js";
import { resolveSchemaReference } from "./schema-reference.js";

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

/** Resolves a non-local `$ref` (a named shape) to the shape and the document its
 *  own `#…` references resolve against. */
export type NamedShapeResolver = (
  ref: string,
) => { schema: Record<string, any>; root: Record<string, any> } | undefined;

/** What `ref`, written in the document `root`, names — a named shape and a
 *  pointer into one read through `resolveRef`'s document — and that node's
 *  document. */
export function referenceTarget(
  ref: string,
  root: Record<string, any>,
  resolveRef: NamedShapeResolver | undefined,
): { schema: Record<string, any>; root: Record<string, any> } | undefined {
  const target = resolveSchemaReference(ref, root, resolveRef && ((id) => resolveRef(id)?.root));
  return target ? { schema: target.node, root: target.document } : undefined;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

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

/** The object a walked field sits in, and the ones enclosing it. */
export interface Holder {
  readonly value: Record<string, unknown>;
  readonly path: ValuePath;
  readonly outer?: Holder;
}

/** One schema node reaching one position. */
export interface SchemaVisit {
  readonly node: Record<string, any>;
  /** The document `node`'s `#…` references resolve against. */
  readonly root: Record<string, any>;
  readonly value: unknown;
  readonly path: ValuePath;
  /** The object holding the position, and the ones enclosing it. */
  readonly holder: Holder | undefined;
  /** Reached through a union branch that definitely cannot hold its value. */
  readonly excluded: boolean;
  /** The value is a boundary: `standing` answered none. Never descended. */
  readonly boundary: boolean;
  /** The visit whose `$ref` led to this node at this same position. */
  readonly referrer?: SchemaVisit;
}

/** A value walked at a position in place of the one written there. */
export interface StandingValue {
  readonly value: unknown;
  readonly path: ValuePath;
}

/** An object value, and the keys of it no schema node reaching it types. */
export interface ResidualKeys {
  readonly value: Record<string, unknown>;
  readonly path: ValuePath;
  readonly holder: Holder | undefined;
  readonly keys: readonly string[];
}

export interface ValueSchemaReader {
  /** Resolves a named shape. Without it a named shape is not followed. */
  readonly resolveRef?: NamedShapeResolver;
  /** Whether `schema` can reach what the reader looks for; when false, the walk
   *  does not start. */
  reaches?(schema: Record<string, any>, root: Record<string, any>): boolean;
  /** The values standing at a position. `undefined`: the value itself; `[]`: a
   *  boundary; otherwise the values walked in its place at the same node. */
  standing?(value: unknown, path: ValuePath): readonly StandingValue[] | undefined;
  visit?(visit: SchemaVisit): "stop" | void;
  referenceSlot?(visit: SchemaVisit, slot: RefSlot): void;
  /** Called once per object value with residual keys, after the walk. */
  residualKeys?(residual: ResidualKeys): void;
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
export function branchExcludes(
  branch: unknown,
  root: Record<string, any>,
  value: unknown,
  path: ValuePath,
  resolveRef: NamedShapeResolver | undefined,
): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).filter((key) => path.length > 0 || !RESOURCE_ENVELOPE.has(key));
  const ancestry = new Set<object>();
  const excludes = (node: unknown, at: Record<string, any>): boolean => {
    if (!isPlainObject(node) || ancestry.has(node)) return false;
    ancestry.add(node);
    try {
      if (typeof node.$ref === "string") {
        const target = referenceTarget(node.$ref, at, resolveRef);
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
 * A memoized "can `schema` reach a node `test` holds" gate, its `#…` references
 * followed against `root`. `test` answers `true` (reached), `false` (opaque: never
 * looked inside) or `undefined` (look further). A named shape is assumed to reach
 * (`namedShapes: "assume"`) or followed through the resolver it is asked with.
 */
export function schemaReachGate(
  test: (node: Record<string, unknown>) => boolean | undefined,
  namedShapes: "assume" | "follow",
): (schema: Record<string, any>, root?: Record<string, any>, resolveRef?: NamedShapeResolver) => boolean {
  const memo = new WeakMap<object, WeakMap<object, boolean>>();
  return (schema, root = schema, resolveRef) => {
    let byNode = memo.get(root);
    if (!byNode) memo.set(root, (byNode = new WeakMap()));
    let known = byNode.get(schema);
    if (known === undefined) {
      const seen = new Set<object>();
      const scan = (node: unknown, at: Record<string, any>): boolean => {
        if (!node || typeof node !== "object" || seen.has(node)) return false;
        seen.add(node);
        if (Array.isArray(node)) return node.some((item) => scan(item, at));
        const verdict = test(node as Record<string, unknown>);
        if (verdict !== undefined) return verdict;
        const ref = (node as Record<string, unknown>).$ref;
        if (typeof ref === "string") {
          if (namedShapes === "assume" && !ref.startsWith("#")) return true;
          const target = referenceTarget(ref, at, namedShapes === "follow" ? resolveRef : undefined);
          if (target && scan(target.schema, target.root)) return true;
        }
        return Object.values(node).some((child) => scan(child, at));
      };
      byNode.set(schema, (known = scan(schema, root)));
    }
    return known;
  };
}

const COMBINATORS = ["$ref", "allOf", "anyOf", "oneOf"] as const;

/** What a node types of an object value's keys: every key, or those it names. */
function typedKeysOf(node: Record<string, any>, value: Record<string, unknown>): "all" | string[] {
  const owns = "properties" in node || "patternProperties" in node || "additionalProperties" in node;
  if (!owns) {
    if (COMBINATORS.some((key) => key in node)) return [];
    const types = node.type === undefined ? undefined : [node.type].flat();
    return types && !types.includes("object") ? [] : "all";
  }
  if (node.additionalProperties !== false) return "all";
  const properties = isPlainObject(node.properties) ? node.properties : {};
  const patterns = isPlainObject(node.patternProperties) ? Object.keys(node.patternProperties) : [];
  return Object.keys(value).filter(
    (key) => Object.hasOwn(properties, key) || patterns.some((pattern) => safeRegExp(pattern)?.test(key)),
  );
}

/** Walks `data` against `schema` (lying in the document `root`), reporting to
 *  `reader`. */
export function walkValueSchema(
  schema: Record<string, any>,
  data: unknown,
  reader: ValueSchemaReader,
  root: Record<string, any> = schema,
): void {
  if (reader.reaches && !reader.reaches(schema, root)) return;
  const resolveRef = reader.resolveRef;
  const entered = new Set<string>();
  const ids = new WeakMap<object, number>();
  let nextId = 0;
  const nodeId = (node: object) => {
    let id = ids.get(node);
    if (id === undefined) ids.set(node, (id = nextId++));
    return id;
  };

  const tracked = reader.residualKeys
    ? new Map<string, { value: Record<string, unknown>; path: ValuePath; holder: Holder | undefined; typed: Set<string> | "all" }>()
    : undefined;
  const typeKeys = (value: unknown, path: ValuePath, holder: Holder | undefined, keys: "all" | readonly string[]) => {
    if (!tracked || !isPlainObject(value)) return;
    const at = renderValuePath(path);
    let entry = tracked.get(at);
    if (!entry) tracked.set(at, (entry = { value, path, holder, typed: new Set() }));
    if (entry.typed === "all") return;
    if (keys === "all") entry.typed = "all";
    else for (const key of keys) entry.typed.add(key);
  };

  const walk = (
    node: unknown,
    root: Record<string, any>,
    value: unknown,
    path: ValuePath,
    holder: Holder | undefined,
    excluded: boolean,
    referrer: SchemaVisit | undefined,
  ): void => {
    if (!node || typeof node !== "object" || Array.isArray(node) || value === undefined) return;
    const declared = node as Record<string, any>;
    const key = `${nodeId(declared)}\0${excluded ? 1 : 0}\0${renderValuePath(path)}`;
    if (entered.has(key)) return;
    entered.add(key);

    const standing = reader.standing?.(value, path);
    if (standing && standing.length > 0) {
      for (const entry of standing) walk(declared, root, entry.value, entry.path, holder, excluded, referrer);
      return;
    }
    const boundary = standing !== undefined;
    const visit: SchemaVisit = { node: declared, root, value, path, holder, excluded, boundary, referrer };
    if (reader.visit?.(visit) === "stop" || boundary) {
      typeKeys(value, path, holder, "all");
      return;
    }
    if (declared["x-telo-ref"] !== undefined) {
      const slot = readRefSlot(declared);
      if (slot) reader.referenceSlot?.(visit, slot);
      typeKeys(value, path, holder, "all");
      return;
    }

    if (typeof declared.$ref === "string") {
      const target = referenceTarget(declared.$ref, root, resolveRef);
      if (target) walk(target.schema, target.root, value, path, holder, excluded, visit);
      else typeKeys(value, path, holder, "all");
    }
    for (const union of ["oneOf", "anyOf", "allOf"] as const) {
      if (Array.isArray(declared[union])) {
        for (const branch of declared[union]) {
          const out = excluded || (union !== "allOf" && branchExcludes(branch, root, value, path, resolveRef));
          walk(branch, root, value, path, holder, out, undefined);
        }
      }
    }
    if (Array.isArray(value)) {
      if (declared.items && typeof declared.items === "object" && !Array.isArray(declared.items)) {
        value.forEach((item, index) => walk(declared.items, root, item, [...path, index], holder, excluded, undefined));
      }
      return;
    }
    if (!isPlainObject(value)) return;
    typeKeys(value, path, holder, typedKeysOf(declared, value));
    const properties = isPlainObject(declared.properties) ? declared.properties : {};
    const patterns = isPlainObject(declared.patternProperties) ? declared.patternProperties : {};
    const here: Holder = { value, path, outer: holder };
    for (const [name, child] of Object.entries(value)) {
      const childPath = [...path, name];
      if (name in properties) {
        walk(properties[name], root, child, childPath, here, excluded, undefined);
        continue;
      }
      let matched = false;
      for (const [pattern, patternSchema] of Object.entries(patterns)) {
        if (safeRegExp(pattern)?.test(name)) {
          matched = true;
          walk(patternSchema, root, child, childPath, here, excluded, undefined);
        }
      }
      if (!matched && declared.additionalProperties && typeof declared.additionalProperties === "object") {
        walk(declared.additionalProperties, root, child, childPath, here, excluded, undefined);
      }
    }
  };
  walk(schema, root, data, [], undefined, false, undefined);

  if (!tracked) return;
  for (const entry of tracked.values()) {
    if (entry.typed === "all") continue;
    const typed = entry.typed;
    const keys = Object.keys(entry.value).filter(
      (key) => !typed.has(key) && (entry.path.length > 0 || !RESOURCE_ENVELOPE.has(key)),
    );
    if (keys.length > 0) reader.residualKeys!({ value: entry.value, path: entry.path, holder: entry.holder, keys });
  }
}
