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

/**
 * Which member of each reached type the annotated node's value must satisfy: a
 * Relative JSON Pointer from the annotated node — `up` levels out, then its key
 * (`#`) or the string at `pointer` beneath it.
 */
export type ValueSchemaMember =
  | { readonly up: number; readonly key: true }
  | { readonly up: number; readonly pointer: readonly string[] };

/** One location as read — or why it cannot be — with the location as written. */
export type ValueSchemaLocation =
  | { readonly raw: unknown; readonly segments: readonly string[]; readonly member?: ValueSchemaMember }
  | { readonly raw: unknown; readonly invalid: string };

const decodeSegment = (segment: string) => segment.replace(/~1/g, "/").replace(/~0/g, "~");

/** A Relative JSON Pointer naming a member, or undefined when it is none: a
 *  non-negative integer, then `#` or a non-empty JSON Pointer. */
export function readValueSchemaMember(raw: unknown): ValueSchemaMember | undefined {
  if (typeof raw !== "string") return undefined;
  const parsed = /^(0|[1-9][0-9]*)(#|(?:\/[^/]+)+)$/.exec(raw);
  if (!parsed) return undefined;
  const up = Number(parsed[1]);
  if (parsed[2] === "#") return { up, key: true };
  return { up, pointer: parsed[2]!.slice(1).split("/").map(decodeSegment) };
}

/**
 * Every location an annotation names, in written order, relative to the
 * declaration. A location is a bare field name, or a JSON Pointer from its root
 * in which a `*` segment ranges over every item of a list; or `{ from, member }`,
 * the same location and the member of each reached type the value must satisfy.
 * A list names several, every type each reaches holding at once; a single
 * location is a list of one. Undefined when the annotation is absent.
 */
export function readValueSchemaLocations(raw: unknown): ValueSchemaLocation[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [readValueSchemaLocation(raw)];
  if (raw.length === 0) {
    return [{ raw, invalid: `'${VALUE_SCHEMA_ANNOTATION}' as a list names at least one location.` }];
  }
  return raw.map((element, index) => {
    const location = Array.isArray(element)
      ? { raw: element, invalid: `a list element is one location, not a list of them.` }
      : readValueSchemaLocation(element);
    if (!("invalid" in location)) return location;
    return {
      raw: element,
      invalid: `element ${index} of the list (\`${describeValueSchemaLocation(element)}\`): ${location.invalid}`,
    };
  });
}

/** One location as written, a list element or the whole annotation. */
function readValueSchemaLocation(raw: unknown): ValueSchemaLocation {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const { from, member, ...rest } = raw as Record<string, unknown>;
    const extra = Object.keys(rest);
    if (extra.length > 0) {
      return { raw, invalid: `'${VALUE_SCHEMA_ANNOTATION}' takes \`from\` and \`member\`; '${extra[0]}' is neither.` };
    }
    if (from === undefined) {
      return { raw, invalid: `'${VALUE_SCHEMA_ANNOTATION}' in its object form names a location under \`from\`.` };
    }
    const location = readValueSchemaLocation(from);
    if ("invalid" in location) return { raw, invalid: location.invalid };
    const read = readValueSchemaMember(member);
    if (!read) {
      return {
        raw,
        invalid:
          `\`member\` is a Relative JSON Pointer from the annotated node naming a property of the ` +
          `type at \`from\`: a non-negative integer, then '#' (that node's own key) or a JSON ` +
          `Pointer to the string naming it — '0#' for a map value's own key.`,
      };
    }
    return { raw, segments: location.segments, member: read };
  }
  if (typeof raw !== "string" || raw.length === 0) {
    return {
      raw,
      invalid: `'${VALUE_SCHEMA_ANNOTATION}' is a field name, a JSON Pointer from the declaration, or a list of them.`,
    };
  }
  if (!raw.startsWith("/")) return { raw, segments: [raw] };
  const segments = raw.slice(1).split("/").map(decodeSegment);
  if (segments.some((segment) => segment.length === 0)) {
    return { raw, invalid: `'${raw}' holds an empty segment; a pointer names one field or '*' per segment.` };
  }
  return { raw, segments };
}

/** The annotation written, or one of its locations, as a message quotes it. */
export function describeValueSchemaLocation(raw: unknown): string {
  if (Array.isArray(raw)) return `[${raw.map(describeValueSchemaLocation).join(", ")}]`;
  if (raw !== null && typeof raw === "object") {
    const { from, member } = raw as Record<string, unknown>;
    return `{ from: ${String(from)}, member: ${String(member)} }`;
  }
  return String(raw);
}

/** What resolving a location needs from its host. */
export interface ValueSchemaHost {
  /** How a location crosses a reference: the reach the host's projections use. */
  readonly scope: ProjectionScope;
  /** The JSON Schema the type field value `value` names, read in the scope of
   *  the declaration holding it. */
  typeSchemaOf(value: unknown, holder: Record<string, any>): Record<string, any> | undefined;
}

/** One type an annotation's locations reach, and the member of it the value
 *  must satisfy when its location names one. */
export interface ValueSchemaReach {
  readonly schema: Record<string, any>;
  readonly member?: ValueSchemaMember;
}

/** Every type the locations `from` names reach from `declaration`, each with its
 *  location's member. A location that reaches nothing, a value naming no type,
 *  or a location that cannot be read contributes nothing. */
export function valueSchemaTypes(
  declaration: Record<string, any>,
  from: unknown,
  host: ValueSchemaHost,
): ValueSchemaReach[] {
  const reaches: ValueSchemaReach[] = [];
  for (const location of readValueSchemaLocations(from) ?? []) {
    if ("invalid" in location) continue;
    for (const { value, holder } of declarationValuesAt(declaration, location.segments, host.scope)) {
      const schema = host.typeSchemaOf(value, holder);
      if (!schema || typeof schema !== "object") continue;
      if (reaches.some((r) => r.schema === schema && r.member === location.member)) continue;
      reaches.push({ schema, member: location.member });
    }
  }
  return reaches;
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
export interface SchemaChild {
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
export function schemaChildren(node: Record<string, any>): SchemaChild[] {
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

/** The key a map value of a contract is typed under: every key. */
const MAP_VALUE = "\0map";

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

  const refTo = (type: Record<string, any>, pointer = "") => ({
    $ref: `#/$defs/${pointerSegment(entryOf(type))}${pointer}`,
  });
  // What one reached type requires of the node: the type itself, or with a
  // `member`, the property its key names — at a fixed key that property, at a
  // map's values each declared property under its own name. A member any other
  // place names is data, unknown to a contract, and contributes nothing.
  const conjunct = (
    type: Record<string, any>,
    member: ValueSchemaMember | undefined,
    key: string | undefined,
  ): Record<string, any> | undefined => {
    if (!member) return refTo(type);
    if (!("key" in member) || member.up !== 0 || key === undefined) return undefined;
    if (key !== MAP_VALUE) {
      const pointer = memberPointerOf(type, key);
      return pointer === undefined ? undefined : refTo(type, pointer);
    }
    const names = memberNamesOf(type);
    return names.length === 0
      ? undefined
      : { properties: Object.fromEntries(names.map((name) => [name, refTo(type, memberPointerOf(type, name))])) };
  };
  const typed = (node: Record<string, any>, key?: string): Record<string, any> => {
    let walked = node;
    for (const child of schemaChildren(node)) {
      const childKey =
        child.keyword === "properties" && typeof child.at === "string"
          ? child.at
          : child.keyword === "additionalProperties" || child.keyword === "patternProperties"
            ? MAP_VALUE
            : undefined;
      const next = typed(child.schema, childKey);
      if (next === child.schema) continue;
      if (walked === node) walked = { ...node };
      if (child.at === undefined) {
        walked[child.keyword] = next;
        continue;
      }
      if (walked[child.keyword] === node[child.keyword]) {
        walked[child.keyword] = Array.isArray(node[child.keyword]) ? [...node[child.keyword]] : { ...node[child.keyword] };
      }
      walked[child.keyword][child.at] = next;
    }
    const conjuncts = valueSchemaTypes(declaration, node[VALUE_SCHEMA_ANNOTATION], host)
      .map(({ schema: type, member }) => conjunct(type, member, key))
      .filter((c): c is Record<string, any> => c !== undefined);
    if (conjuncts.length === 0) return walked;
    const { [VALUE_SCHEMA_ANNOTATION]: _dropped, ...rest } = walked;
    return {
      ...rest,
      allOf: [...(Array.isArray(rest.allOf) ? rest.allOf : []), ...conjuncts],
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

/** One value level a schema node sits beneath: the node, and whether the value
 *  there is reached by a key (an object member or map value) or an index. */
interface ValueLevel {
  readonly node: Record<string, any>;
  readonly step: "key" | "index";
}

/** One annotation as a definition's schema tree writes it. */
export interface ValueSchemaAnnotation {
  /** Where it is written, from the tree's root (`properties.context`). */
  readonly path: string;
  readonly raw: unknown;
  /** The value levels from the tree's root down to the annotated node. */
  readonly levels: readonly ValueLevel[];
}

const KEY_KEYWORDS: ReadonlySet<string> = new Set(["properties", "additionalProperties", "patternProperties"]);

/** Every `x-telo-value-schema-from` a schema tree writes — exactly the nodes
 *  {@link resolveContractValueSchemas} types. */
export function valueSchemaAnnotations(schema: unknown, path = ""): ValueSchemaAnnotation[] {
  if (!isSchemaNode(schema)) return [];
  const out: ValueSchemaAnnotation[] = [];
  const seen = new Set<object>();
  const join = (base: string, key: string | number): string =>
    typeof key === "number" ? `${base}[${key}]` : base === "" ? key : `${base}.${key}`;
  const walk = (node: Record<string, any>, at: string, levels: readonly ValueLevel[]): void => {
    if (seen.has(node)) return;
    seen.add(node);
    if (node[VALUE_SCHEMA_ANNOTATION] !== undefined) {
      out.push({ path: at, raw: node[VALUE_SCHEMA_ANNOTATION], levels });
    }
    for (const child of schemaChildren(node)) {
      const under = join(at, child.keyword);
      const step = KEY_KEYWORDS.has(child.keyword) ? "key" : child.keyword === "items" ? "index" : undefined;
      walk(
        child.schema,
        child.at === undefined ? under : join(under, child.at),
        step ? [...levels, { node: child.schema, step }] : levels,
      );
    }
  };
  walk(schema, path, []);
  return out;
}

/**
 * Why an annotation's `member` cannot name a property at the place it is
 * written, or undefined when it can: `#` must land on a value reached by a key,
 * and a pointer on a string.
 */
export function valueSchemaMemberProblem(
  root: Record<string, any>,
  annotation: ValueSchemaAnnotation,
  member: ValueSchemaMember,
): string | undefined {
  const { levels } = annotation;
  if (member.up > levels.length) {
    return `\`member\` climbs ${member.up} level(s) out of a node only ${levels.length} level(s) deep.`;
  }
  const depth = levels.length - member.up;
  if ("key" in member) {
    return depth >= 1 && levels[depth - 1]!.step === "key"
      ? undefined
      : `\`member\` takes the key of a node that is no map value or object member, so it has no key naming a property.`;
  }
  let node: Record<string, any> | undefined = depth === 0 ? root : levels[depth - 1]!.node;
  for (const segment of member.pointer) {
    node = localTarget(node, root);
    const next = (node?.properties as Record<string, unknown> | undefined)?.[segment];
    node = next && typeof next === "object" ? (next as Record<string, any>) : undefined;
    if (!node) return `\`member\` names '${member.pointer.join("/")}', which the schema does not declare there.`;
  }
  node = localTarget(node, root);
  return node && holdsOnlyStrings(node)
    ? undefined
    : `\`member\` names '${member.pointer.join("/")}', which is not declared a string, so it cannot name a property.`;
}

function holdsOnlyStrings(node: Record<string, any>): boolean {
  if (node.type === "string") return true;
  if (Array.isArray(node.type)) return node.type.length > 0 && node.type.every((t: unknown) => t === "string");
  if (typeof node.const === "string") return true;
  return Array.isArray(node.enum) && node.enum.length > 0 && node.enum.every((v: unknown) => typeof v === "string");
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

/** One annotated slot: its scope (`$.outputs`, `$.rows[*].value`, `$.filters.*`
 *  for every value of a map) and the annotation as written. */
export interface ValueSchemaSlot {
  readonly scope: string;
  readonly from: unknown;
}

/** Every `x-telo-value-schema-from` slot a kind's schema declares. */
export function valueSchemaSlots(schema: Record<string, any>, path = "$"): ValueSchemaSlot[] {
  if (!schema || typeof schema !== "object") return [];
  const out: ValueSchemaSlot[] = [];
  const from = schema[VALUE_SCHEMA_ANNOTATION];
  if ((typeof from === "string" && from.length > 0) || (from !== null && typeof from === "object")) {
    out.push({ scope: path, from });
  }
  if (schema.properties) {
    for (const [key, value] of Object.entries(schema.properties as Record<string, any>)) {
      out.push(...valueSchemaSlots(value, `${path}.${key}`));
    }
  }
  for (const map of [schema.additionalProperties, ...Object.values(schema.patternProperties ?? {})]) {
    if (map && typeof map === "object") out.push(...valueSchemaSlots(map as Record<string, any>, `${path}.*`));
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

/** Whether a slot's scope names one value per resource — no `[*]` or `.*`
 *  segment. */
export function isSingleValueScope(scope: string): boolean {
  return !scope.includes("[*]") && !scope.split(".").includes("*");
}

/** Expand a `$.a[*].b` / `$.m.*` scope into the concrete values present, each
 *  with its path. */
export function resolveScopeValues(
  manifest: Record<string, any>,
  scope: string,
): Array<{ path: string; value: unknown }> {
  const stripped = scope.startsWith("$.") ? scope.slice(2) : scope;
  if (!stripped) return [];
  let frontier: Array<{ path: string; value: unknown }> = [{ path: "", value: manifest }];
  for (const segment of stripped.split(".")) {
    const next: Array<{ path: string; value: unknown }> = [];
    if (segment === "*") {
      for (const entry of frontier) {
        const map = entry.value;
        if (!map || typeof map !== "object" || Array.isArray(map)) continue;
        for (const [key, value] of Object.entries(map)) {
          next.push({ path: entry.path ? `${entry.path}.${key}` : key, value });
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
      continue;
    }
    const wildcard = segment.endsWith("[*]");
    const name = wildcard ? segment.slice(0, -3) : segment;
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

/** The segments of a concrete path (`a.b[2].c` → `a`, `b`, `2`, `c`). */
function concreteSegments(path: string): string[] {
  const out: string[] = [];
  for (const part of path.split(".")) {
    const parsed = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!parsed) return [];
    if (parsed[1]) out.push(parsed[1]);
    for (const index of parsed[2]!.match(/\d+/g) ?? []) out.push(index);
  }
  return out;
}

/** The member name a site's annotation names: the key `up` levels out, or the
 *  string at `pointer` beneath that node. Undefined when it holds no string. */
export function memberNameAt(
  manifest: Record<string, any>,
  path: string,
  member: ValueSchemaMember,
): string | undefined {
  const segments = concreteSegments(path);
  if (member.up > segments.length) return undefined;
  const at = segments.slice(0, segments.length - member.up);
  if ("key" in member) {
    const key = at[at.length - 1];
    if (key === undefined) return undefined;
    let parent: unknown = manifest;
    for (const segment of at.slice(0, -1)) parent = (parent as Record<string, unknown> | undefined)?.[segment];
    return parent && typeof parent === "object" && !Array.isArray(parent) ? key : undefined;
  }
  let node: unknown = manifest;
  for (const segment of [...at, ...member.pointer]) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === "string" ? node : undefined;
}

/** The reserved root-level `$defs` key a member's type is carried under. */
const MEMBER_TYPE_KEY = "telo:value-schema-member";

/**
 * The schema of property `name` of `type`, carried with the type's own document
 * so a `#…` reference inside it still resolves. Undefined when the type
 * declares no such property — an undeclared key contributes nothing.
 */
export function memberTypeOf(type: Record<string, any>, name: string): Record<string, any> | undefined {
  const pointer = memberPointerOf(type, name);
  if (pointer === undefined) return undefined;
  return {
    $ref: `#/$defs/${pointerSegment(MEMBER_TYPE_KEY)}${pointer}`,
    $defs: { [MEMBER_TYPE_KEY]: rebasedType(type, MEMBER_TYPE_KEY) },
  };
}

/** The type's root with its document-local `$ref` chain followed, and where
 *  that chain lands, as a pointer into the type. */
function typeRootOf(type: Record<string, any>): { node: Record<string, any> | undefined; at: string } {
  let at = "";
  let node: Record<string, any> | undefined = type;
  const seen = new Set<unknown>();
  while (node && typeof node.$ref === "string" && node.$ref.startsWith("#") && !seen.has(node)) {
    seen.add(node);
    at = node.$ref.slice(1);
    const next = resolveSchemaPointer(type, node.$ref);
    node = next && typeof next === "object" && !Array.isArray(next) ? (next as Record<string, any>) : undefined;
  }
  return { node, at };
}

/** The pointer, within `type`, to its property `name`, or undefined. */
function memberPointerOf(type: Record<string, any>, name: string): string | undefined {
  const { node, at } = typeRootOf(type);
  const property = (node?.properties as Record<string, unknown> | undefined)?.[name];
  return property && typeof property === "object" ? `${at}/properties/${pointerSegment(name)}` : undefined;
}

/** The property names `type` declares at its root. */
function memberNamesOf(type: Record<string, any>): string[] {
  const properties = typeRootOf(type).node?.properties;
  return properties && typeof properties === "object" ? Object.keys(properties) : [];
}
