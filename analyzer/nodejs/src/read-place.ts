/**
 * The places an annotation reads for one annotated node — what each
 * annotation's own reader reports through the read table
 * (`annotation-reads.ts`), so a check judged per site knows every value its
 * verdict may depend on.
 *
 * Browser-safe.
 */

export type ReadKeys = readonly (string | number)[];

/** A declaration a reference names, as a reporter reads it: its value where it
 *  is read, the schema its kind declares, the named shapes that schema
 *  reaches, and the definition its kind resolves to — what the kind declares
 *  beside its schema. */
export interface Referent {
  readonly value: Record<string, any>;
  readonly schema: Record<string, any> | undefined;
  readonly shapeOf: (ref: string) => Record<string, any> | undefined;
  readonly definition: Record<string, any> | undefined;
}

/** A declaration referencing the one read, as a reporter reads it: a referent
 *  whose `slots` are the places holding a reference to the declaration read. */
export interface Referrer extends Referent {
  readonly slots: readonly ReadKeys[];
}

/** A place read in a declaration a reference names. */
export type ReferentPlace =
  | Exclude<ReadPlace, { readonly kind: "referrers" }>
  /** What a CEL site at a data path reads through the annotations on the way
   *  to it — the scope in force there. */
  | { readonly kind: "scope"; readonly keys: ReadKeys };

/** The places a reference read reads in each declaration a reference names —
 *  its identity (`kind`, `metadata`) besides; `[{ kind: "value", keys: [] }]`
 *  reads it whole. */
export type ReferentReads = (referent: Referent) => readonly ReferentPlace[];

/** The places a referrers read reads in each declaration referencing the one
 *  read — its identity and each of its slots besides. */
export type ReferrerReads = (referrer: Referrer) => readonly ReferentPlace[];

/** A place an annotation reads, for one annotated node. */
export type ReadPlace =
  /** A value of the same declaration, at a data path from its root. */
  | { readonly kind: "value"; readonly keys: ReadKeys }
  /** Which members of the object at a data path hold a tagged value (an
   *  expression, an embed — never a reference), and each such value. */
  | { readonly kind: "tagged"; readonly keys: ReadKeys }
  /** The value at a data path, every reference it holds, and in each
   *  declaration those name the places `reads` names — and, `transitive`, the
   *  same places in each declaration a reference at those places names, onward. */
  | { readonly kind: "reference"; readonly keys: ReadKeys; readonly transitive: boolean; readonly reads: ReferentReads }
  /** Every declaration referencing this one: in each, the places `reads`
   *  names. */
  | { readonly kind: "referrers"; readonly reads: ReferrerReads };

/** One annotated node, as a reporter reads it. */
export interface AnnotatedNode {
  /** The annotation's own value. */
  readonly value: unknown;
  /** The schema node it is written on. */
  readonly node: Record<string, any>;
  /** The data path of the annotated node, from the declaration's root. */
  readonly at: ReadKeys;
  /** The deepest list element on the way to the sites the node covers, at or
   *  one below the node — the item a context region's bindings are read off —
   *  else the root. */
  readonly item: ReadKeys;
  /** The reads of the annotations written on another schema node — a binding
   *  of a context region — read as if written at `at`. */
  readonly delegate: (node: Record<string, any>) => readonly ReadPlace[];
  /** The definition the kind of the declaration holding the node resolves to. */
  readonly definition: Record<string, any> | undefined;
}

export type ReadReporter = (annotated: AnnotatedNode) => readonly ReadPlace[];

/** The object enclosing the annotated node: its parent, past an array index. */
export function enclosingKeys(at: ReadKeys): ReadKeys {
  if (at.length === 0) return at;
  return at.slice(0, typeof at[at.length - 1] === "number" ? at.length - 2 : at.length - 1);
}

/**
 * A JSON Pointer (`/a/b`) from `base`, or a Relative JSON Pointer (`0/rows`,
 * `2/rows`, `1#`) climbing from it; a `*` or `-` segment ends the place there,
 * since every member below it is read. A bare word is a field of `base`.
 */
export function placeAt(base: ReadKeys, pointer: string): ReadKeys {
  let keys: (string | number)[] = [...base];
  let rest = pointer;
  const relative = /^(\d+)(#|\/|$)/.exec(pointer);
  if (relative) {
    const up = Number(relative[1]);
    keys = keys.slice(0, Math.max(0, keys.length - up));
    if (relative[2] === "#") return keys;
    rest = pointer.slice(relative[1]!.length);
  } else if (!pointer.startsWith("/")) {
    rest = `/${pointer}`;
  }
  for (const raw of rest.split("/").slice(1)) {
    if (raw === "") continue;
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (segment === "*" || segment === "-") break;
    keys.push(/^\d+$/.test(segment) ? Number(segment) : segment);
  }
  return keys;
}

/** A field name or a `/`-separated path from `base`, as most annotations write
 *  the place they read. */
export function fieldPlace(base: ReadKeys, field: unknown): ReadKeys | undefined {
  if (typeof field !== "string" || field.length === 0) return undefined;
  return placeAt(base, field.startsWith("/") || /^\d/.test(field) ? field : `/${field}`);
}

/** Reads a declaration whole — for a reader whose verdict may depend on any of
 *  it. */
export const READS_WHOLE: ReferentReads = () => [{ kind: "value", keys: [] }];

/** Reads a declaration as its identity alone — for a reader whose verdict
 *  depends only on what is named: its kind, and a named shape, which is held
 *  whole. */
export const READS_IDENTITY: ReferentReads = () => [];

/** Reads, in each declaration referencing the one read, the scope in force at
 *  each of its slots. */
export const READS_SLOT_SCOPES: ReferrerReads = (referrer) =>
  referrer.slots.map((keys) => ({ kind: "scope", keys }));

type Schema = Record<string, any>;

const isSchema = (node: unknown): node is Schema => !!node && typeof node === "object" && !Array.isArray(node);

function localTarget(root: Schema, ref: string): unknown {
  let node: unknown = root;
  for (const raw of ref.slice(1).split("/").slice(1)) {
    if (!isSchema(node)) return undefined;
    node = node[raw.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return node;
}

/**
 * The places of a referent whose value its kind's schema says may hold a node
 * `holds` accepts: the members, by fixed property names, on the way to each
 * such node — a list or a map on the way ends a place there, every member
 * below it being read. Read from the schema alone, through local and named
 * references and every union branch, so where a referent is read is the same
 * whatever it holds.
 */
export function kindPlaces(referent: Referent, holds: (node: Schema) => boolean): ReadKeys[] {
  const out: ReadKeys[] = [];
  const add = (keys: ReadKeys): void => {
    if (out.some((held) => held.length <= keys.length && held.every((key, i) => key === keys[i]))) return;
    for (let i = out.length - 1; i >= 0; i--) {
      const held = out[i]!;
      if (held.length > keys.length && keys.every((key, j) => key === held[j])) out.splice(i, 1);
    }
    out.push(keys);
  };
  const resolved = (node: Schema, document: Schema): { node: unknown; document: Schema } | undefined => {
    if (typeof node.$ref !== "string") return undefined;
    if (node.$ref.startsWith("#")) return { node: localTarget(document, node.$ref), document };
    const shape = referent.shapeOf(node.$ref);
    return shape ? { node: shape, document: shape } : undefined;
  };
  const reaching = new Map<object, boolean>();
  const reaches = (node: unknown, document: Schema, seen: Set<object>): boolean => {
    if (!isSchema(node) || seen.has(node)) return false;
    const known = reaching.get(node);
    if (known !== undefined) return known;
    seen.add(node);
    let found = holds(node);
    const target = found ? undefined : resolved(node, document);
    if (target) found = reaches(target.node, target.document, seen);
    const children: unknown[] = [];
    for (const branch of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) if (Array.isArray(node[branch])) children.push(...node[branch]);
    for (const map of ["properties", "patternProperties"] as const) if (isSchema(node[map])) children.push(...Object.values(node[map]));
    children.push(node.items, node.additionalProperties);
    for (const child of children) if (!found && reaches(child, document, seen)) found = true;
    seen.delete(node);
    if (seen.size === 0) reaching.set(node, found);
    return found;
  };
  const walk = (node: unknown, document: Schema, keys: ReadKeys, seen: ReadonlySet<object>): void => {
    if (!isSchema(node) || seen.has(node)) return;
    const guard = new Set(seen).add(node);
    if (holds(node)) {
      add(keys);
      return;
    }
    const target = resolved(node, document);
    if (target) walk(target.node, target.document, keys, guard);
    for (const branch of ["allOf", "anyOf", "oneOf"] as const) {
      if (Array.isArray(node[branch])) for (const member of node[branch]) walk(member, document, keys, guard);
    }
    if (isSchema(node.properties)) {
      for (const [name, child] of Object.entries(node.properties)) walk(child, document, [...keys, name], guard);
    }
    const open: unknown[] = [node.items, node.additionalProperties];
    if (Array.isArray(node.prefixItems)) open.push(...node.prefixItems);
    if (isSchema(node.patternProperties)) open.push(...Object.values(node.patternProperties));
    if (open.some((child) => reaches(child, document, new Set()))) add(keys);
  };
  if (referent.schema) walk(referent.schema, referent.schema, [], new Set());
  return out;
}

/**
 * What a JSON Pointer crossing references (`/options/model`) reads in
 * each declaration it crosses into: the place each part of it
 * continuing past a member names, from the referent's root — wherever along
 * the pointer the reference stands — the rest of the pointer read onward by
 * the same places.
 */
export function pointerReads(pointers: readonly string[]): ReferentReads {
  const read: ReferentPlace[] = pointerPlaces(pointers).map((keys) => ({ kind: "value", keys }));
  return () => read;
}

/** Where a JSON Pointer that may cross references is read in the declaration
 *  it is written for: its first member, whatever it holds — the place every
 *  reference on the way to the rest stands in. */
export function crossingPlace(pointer: string): ReadKeys {
  return placeAt([], `/${pointer.split("/")[1] ?? ""}`);
}

/** The places of {@link pointerReads}. */
export function pointerPlaces(pointers: readonly string[]): ReadKeys[] {
  const places = new Map<string, ReadKeys>();
  for (const pointer of pointers) {
    const segments = pointer.split("/").slice(1);
    for (let i = 1; i < segments.length; i++) {
      if (segments[i] === "*" || segments[i] === "-") continue;
      const keys = placeAt([], `/${segments.slice(i).join("/")}`);
      places.set(JSON.stringify(keys), keys);
    }
  }
  return [...places.values()];
}
