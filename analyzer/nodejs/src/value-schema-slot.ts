/**
 * The single reader of `x-telo-value-schema-from`: which value slots of a kind
 * name a type field, the values a manifest holds at each, and the types a
 * location names.
 *
 * Read forward by the value-schema check and the kernel's literal decoding
 * (`derived-slots.ts`), in reverse by the contract an undeclared type field
 * implies (`value-derived-contract.ts`), and inside an invocation contract by
 * the contract resolver both halves share (`invocation-contract.ts`). One
 * reader, so no two of them disagree about what the annotation marks or where
 * its location leads.
 */
import { isRefSlot } from "./ref-slot.js";
import { resolveSchemaPointer } from "./manifest-navigation.js";
import { declarationValuesAt, type ProjectionScope } from "./schema-projection.js";

const VALUE_SCHEMA_ANNOTATION = "x-telo-value-schema-from";

/** A location as read, or why the annotation that is present cannot be read. */
export type ValueSchemaLocation =
  | { readonly segments: readonly string[] }
  | { readonly invalid: string };

/**
 * The location an annotation names, relative to the declaration: a bare field
 * name, or a JSON Pointer from its root in which a `*` segment ranges over every
 * item of a list. Undefined when the annotation is absent.
 */
export function readValueSchemaLocation(raw: unknown): ValueSchemaLocation | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0) {
    return { invalid: `'${VALUE_SCHEMA_ANNOTATION}' is a field name, or a JSON Pointer from the declaration.` };
  }
  if (!raw.startsWith("/")) return { segments: [raw] };
  const segments = raw
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segments.some((segment) => segment.length === 0)) {
    return { invalid: `'${raw}' holds an empty segment; a pointer names one field or '*' per segment.` };
  }
  return { segments };
}

/** What resolving a location needs from its host. */
export interface ValueSchemaHost {
  /** How a location crosses a reference: the reach the host's projections use. */
  readonly scope: ProjectionScope;
  /** The JSON Schema the type field value `value` names, read in the scope of
   *  the declaration holding it. */
  typeSchemaOf(value: unknown, holder: Record<string, any>): Record<string, any> | undefined;
}

/** Every type the location `from` names from `declaration`. A location that
 *  reaches nothing, or a value naming no type, contributes nothing. */
export function valueSchemaTypes(
  declaration: Record<string, any>,
  from: unknown,
  host: ValueSchemaHost,
): Record<string, any>[] {
  const location = readValueSchemaLocation(from);
  if (!location || "invalid" in location) return [];
  const types: Record<string, any>[] = [];
  for (const { value, holder } of declarationValuesAt(declaration, location.segments, host.scope)) {
    const schema = host.typeSchemaOf(value, holder);
    if (schema && typeof schema === "object" && !types.includes(schema)) types.push(schema);
  }
  return types;
}

/** Keywords whose value is data, never a schema. */
const DATA_KEYWORDS: ReadonlySet<string> = new Set(["default", "const", "enum", "examples"]);

/** Keywords whose value maps NAMES to schemas: a key beneath one is a name an
 *  author chose, whatever it spells — a property named `default` is a schema,
 *  the `default` keyword beside it is data. */
const NAME_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
]);

/** One schema directly beneath a schema node: the keyword holding it, and the
 *  name or index it sits at when the keyword holds several. */
interface SchemaChild {
  readonly keyword: string;
  readonly at?: string | number;
  readonly schema: Record<string, any>;
}

const isSchemaNode = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The schemas directly beneath `node` — the one traversal every reader of the
 * annotation walks, so typing a node and judging its annotation cannot disagree
 * about where a schema is. A keyword position is told from a name position: the
 * value of `default` / `const` / `enum` / `examples` is data and holds no
 * schema, while an entry of a name map is a schema whatever it is called.
 */
function schemaChildren(node: Record<string, any>): SchemaChild[] {
  const out: SchemaChild[] = [];
  for (const [keyword, value] of Object.entries(node)) {
    if (keyword.startsWith("x-telo-") || DATA_KEYWORDS.has(keyword)) continue;
    if (Array.isArray(value)) {
      value.forEach((schema, at) => {
        if (isSchemaNode(schema)) out.push({ keyword, at, schema });
      });
    } else if (!isSchemaNode(value)) {
      continue;
    } else if (NAME_MAP_KEYWORDS.has(keyword)) {
      for (const [at, schema] of Object.entries(value)) {
        if (isSchemaNode(schema)) out.push({ keyword, at, schema });
      }
    } else {
      out.push({ keyword, schema: value });
    }
  }
  return out;
}

/** `node` with each child schema replaced by what `map` returns for it, and
 *  `node` itself when none moved. */
function withSchemaChildren(
  node: Record<string, any>,
  map: (child: Record<string, any>) => Record<string, any>,
): Record<string, any> {
  let out: Record<string, any> | undefined;
  for (const { keyword, at, schema } of schemaChildren(node)) {
    const next = map(schema);
    if (next === schema) continue;
    out ??= { ...node };
    if (at === undefined) {
      out[keyword] = next;
      continue;
    }
    if (out[keyword] === node[keyword]) {
      out[keyword] = Array.isArray(node[keyword]) ? [...node[keyword]] : { ...node[keyword] };
    }
    out[keyword][at] = next;
  }
  return out ?? node;
}

/** The reserved root-level `$defs` key a reached type is carried under. */
const REACHED_TYPE_KEY = "telo:value-schema-from:";

/**
 * A contract schema with every annotated node typed by the declaration it is
 * bound to: the node keeps its own keywords and every type its location names
 * must hold as well (`allOf`).
 *
 * Each reached type is its own document, so it is carried WHOLE under a reserved
 * `$defs` entry of the contract's root and referenced from the node, with its
 * document-local references rebased onto that entry — spliced into the node
 * instead, a type's `#/$defs/…` would resolve against the contract.
 *
 * Structural, and a schema no location typed is returned by IDENTITY — the
 * contract then says what it says without the annotation, and a validator
 * memoized on the schema object stays warm.
 */
export function resolveContractValueSchemas(
  schema: unknown,
  declaration: Record<string, any> | undefined,
  host: ValueSchemaHost,
): unknown {
  if (!declaration || !isSchemaNode(schema) || !carriesAnnotation(schema)) return schema;
  const taken = new Set(Object.keys(isSchemaNode(schema.$defs) ? schema.$defs : {}));
  const reached = new Map<object, string>();
  const entryOf = (type: Record<string, any>): string => {
    let key = reached.get(type);
    if (key !== undefined) return key;
    let index = reached.size;
    do key = `${REACHED_TYPE_KEY}${index++}`;
    while (taken.has(key));
    taken.add(key);
    reached.set(type, key);
    return key;
  };

  const typed = (node: Record<string, any>): Record<string, any> => {
    const walked = withSchemaChildren(node, typed);
    const types = valueSchemaTypes(declaration, node[VALUE_SCHEMA_ANNOTATION], host);
    if (types.length === 0) return walked;
    const { [VALUE_SCHEMA_ANNOTATION]: _dropped, ...rest } = walked;
    return {
      ...rest,
      allOf: [
        ...(Array.isArray(rest.allOf) ? rest.allOf : []),
        ...types.map((type) => ({ $ref: `#/$defs/${pointerSegment(entryOf(type))}` })),
      ],
    };
  };

  const root = typed(schema);
  if (reached.size === 0) return root;
  const defs: Record<string, any> = { ...(isSchemaNode(root.$defs) ? root.$defs : {}) };
  for (const [type, key] of reached) defs[key] = rebasedType(type as Record<string, any>, key);
  return { ...root, $defs: defs };
}

const pointerSegment = (key: string): string => key.replace(/~/g, "~0").replace(/\//g, "~1");

/** A reached type as the entry `key` of the contract's `$defs`: every `#…`
 *  reference inside it names the entry rather than the contract (`#` is the
 *  entry itself). A reference to a named shape is left as written. */
function rebasedType(type: Record<string, any>, key: string): Record<string, any> {
  const entry = `#/$defs/${pointerSegment(key)}`;
  const rebase = (node: Record<string, any>): Record<string, any> => {
    const walked = withSchemaChildren(node, rebase);
    const ref = walked.$ref;
    if (typeof ref !== "string" || !(ref === "#" || ref.startsWith("#/"))) return walked;
    return { ...walked, $ref: `${entry}${ref.slice(1)}` };
  };
  const { $id: _id, ...rebased } = rebase(type);
  return rebased;
}

const annotationCarriers = new WeakMap<object, boolean>();

/** Whether a schema tree writes the annotation anywhere — remembered per
 *  contract, since one is resolved for every call site that names it. */
function carriesAnnotation(schema: Record<string, any>): boolean {
  const known = annotationCarriers.get(schema);
  if (known !== undefined) return known;
  const seen = new Set<object>();
  const carries = (node: Record<string, any>): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    return (
      node[VALUE_SCHEMA_ANNOTATION] !== undefined ||
      schemaChildren(node).some((child) => carries(child.schema))
    );
  };
  const result = carries(schema);
  annotationCarriers.set(schema, result);
  return result;
}

/** One annotation as a definition's schema tree writes it. */
export interface ValueSchemaAnnotation {
  /** Where it is written, from the tree's root (`properties.context`). */
  readonly path: string;
  readonly raw: unknown;
}

/** Every `x-telo-value-schema-from` a schema tree writes — exactly the nodes
 *  {@link resolveContractValueSchemas} types. */
export function valueSchemaAnnotations(schema: unknown, path = ""): ValueSchemaAnnotation[] {
  if (!isSchemaNode(schema)) return [];
  const out: ValueSchemaAnnotation[] = [];
  const seen = new Set<object>();
  const join = (base: string, key: string | number): string =>
    typeof key === "number" ? `${base}[${key}]` : base === "" ? key : `${base}.${key}`;
  const walk = (node: Record<string, any>, at: string): void => {
    if (seen.has(node)) return;
    seen.add(node);
    if (node[VALUE_SCHEMA_ANNOTATION] !== undefined) {
      out.push({ path: at, raw: node[VALUE_SCHEMA_ANNOTATION] });
    }
    for (const child of schemaChildren(node)) {
      const under = join(at, child.keyword);
      walk(child.schema, child.at === undefined ? under : join(under, child.at));
    }
  };
  walk(schema, path);
  return out;
}

/**
 * Whether a kind's schema can hold a value at `segments`: every segment up to
 * the first reference slot names a declared property (a map's value schema, a
 * list's items for `*`), through local `$ref`s and union branches. Past a
 * reference slot the location continues in another declaration, whose kind the
 * schema does not fix; a node typed from elsewhere (`x-telo-schema-from`, a
 * non-local `$ref`) is likewise not this schema's to refuse.
 */
export function schemaReachesLocation(
  schema: Record<string, any>,
  segments: readonly string[],
): boolean {
  const reaches = (raw: unknown, rest: readonly string[], seen: readonly object[]): boolean => {
    const node = localTarget(raw, schema);
    if (!node || seen.includes(node)) return false;
    if (rest.length === 0) return true;
    if (isRefSlot(node) || node["x-telo-schema-from"] !== undefined) return true;
    if (typeof node.$ref === "string") return true;
    const here = [...seen, node];
    const [segment, ...tail] = rest;
    if (segment === "*") {
      if (node.items && typeof node.items === "object" && reaches(node.items, tail, [])) return true;
    } else {
      const property = (node.properties as Record<string, unknown> | undefined)?.[segment!];
      if (property !== undefined && reaches(property, tail, [])) return true;
      const additional = node.additionalProperties;
      if (additional && typeof additional === "object" && reaches(additional, tail, [])) return true;
      for (const pattern of Object.values((node.patternProperties ?? {}) as Record<string, unknown>)) {
        if (reaches(pattern, tail, [])) return true;
      }
    }
    for (const key of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = node[key];
      if (Array.isArray(branches) && branches.some((branch) => reaches(branch, rest, here))) return true;
    }
    return false;
  };
  return reaches(schema, segments, []);
}

/** A node with its document-local `$ref` chain followed. */
function localTarget(node: unknown, root: Record<string, any>): Record<string, any> | undefined {
  let current = node;
  const seen = new Set<unknown>();
  while (
    current &&
    typeof current === "object" &&
    typeof (current as Record<string, any>).$ref === "string" &&
    (current as Record<string, any>).$ref.startsWith("#")
  ) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    current = resolveSchemaPointer(root, (current as Record<string, any>).$ref);
  }
  return current && typeof current === "object" && !Array.isArray(current)
    ? (current as Record<string, any>)
    : undefined;
}

/** One annotated slot: its scope (`$.outputs`, `$.rows[*].value`) and the
 *  resource field naming the type its value must satisfy. */
export interface ValueSchemaSlot {
  readonly scope: string;
  readonly from: string;
}

/** Every `x-telo-value-schema-from` slot a kind's schema declares. */
export function valueSchemaSlots(schema: Record<string, any>, path = "$"): ValueSchemaSlot[] {
  if (!schema || typeof schema !== "object") return [];
  const out: ValueSchemaSlot[] = [];
  const from = schema[VALUE_SCHEMA_ANNOTATION];
  if (typeof from === "string" && from.length > 0) out.push({ scope: path, from });
  if (schema.properties) {
    for (const [key, value] of Object.entries(schema.properties as Record<string, any>)) {
      out.push(...valueSchemaSlots(value, `${path}.${key}`));
    }
  }
  if (schema.items && typeof schema.items === "object") {
    out.push(...valueSchemaSlots(schema.items, `${path}[*]`));
  }
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(schema[key])) {
      for (const sub of schema[key]) out.push(...valueSchemaSlots(sub, path));
    }
  }
  return out;
}

/** Whether a slot's scope names one value per resource — no `[*]` segment. */
export function isSingleValueScope(scope: string): boolean {
  return !scope.includes("[*]");
}

/** Expand a `$.a[*].b` scope into the concrete values present, each with its path. */
export function resolveScopeValues(
  manifest: Record<string, any>,
  scope: string,
): Array<{ path: string; value: unknown }> {
  const stripped = scope.startsWith("$.") ? scope.slice(2) : scope;
  if (!stripped) return [];
  let frontier: Array<{ path: string; value: unknown }> = [{ path: "", value: manifest }];
  for (const segment of stripped.split(".")) {
    const wildcard = segment.endsWith("[*]");
    const name = wildcard ? segment.slice(0, -3) : segment;
    const next: Array<{ path: string; value: unknown }> = [];
    for (const entry of frontier) {
      const container = entry.value as Record<string, unknown> | undefined;
      if (!container || typeof container !== "object") continue;
      const child = container[name];
      if (child === undefined) continue;
      const childPath = entry.path ? `${entry.path}.${name}` : name;
      if (!wildcard) {
        next.push({ path: childPath, value: child });
        continue;
      }
      if (!Array.isArray(child)) continue;
      child.forEach((item, i) => next.push({ path: `${childPath}[${i}]`, value: item }));
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return frontier;
}
