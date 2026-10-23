/**
 * Where a manifest holds SCHEMAS, and what the text vocabulary reads off them.
 *
 * A schema a resource holds is one of three things, told apart by topology:
 *
 * - a KIND schema — a `Telo.Definition` / `Telo.Abstract`'s own `schema:`
 *   (`KindSchema`): the configuration authors write, documented for authors;
 * - a DATA schema — every `JsonSchema7`-stamped slot (a `Telo.JsonSchema`'s
 *   `schema`, a `status:` block, a callable's parameter and result schemas), every
 *   contract field (`inputType` / `outputType`, every form, on definitions and
 *   instances alike) and the inline value at every `use: schema` reference slot:
 *   the shape of data, whose `title`, `description` and enum labels a person sees;
 * - a callable's PARAMETER LIST (`CallableParams`), whose argument record is what a
 *   parameter's `x-telo-text-values-for` pointer is relative to.
 *
 * Read by `telo check` (the text enumeration, `x-telo-text-context` /
 * `x-telo-text-values-for` placement and shape) and by the kernel at creation (the
 * same refusals, raised for the resource holding the schema). Browser-safe.
 */
import { serializePattern } from "@telorun/sdk";
import { isHoistedFragmentDefKey, manifestFragmentOf } from "./manifest-schemas.js";
import { resolveSchemaPointer } from "./manifest-navigation.js";
import { readRefSlot } from "./ref-slot.js";
import { SCHEMA_REGION_KEYS } from "./schema-region.js";
import { textKey } from "./text-judgement.js";
import {
  isTextSchema,
  pointerSegments,
  renderValuePath,
  TEXT_CONTEXT_ANNOTATION,
  TEXT_VALUES_FOR_ANNOTATION,
  type ValuePath,
} from "./text-slot.js";
import { isResolvedReference } from "./resolved-reference.js";

export type SchemaRole = "kind" | "data" | "params";

/** One schema a manifest holds. */
export interface SchemaValueSite {
  readonly role: SchemaRole;
  readonly path: ValuePath;
  /** The schema (for `params`, the parameter list). */
  readonly value: unknown;
  /** A parameter's own schema: its root's values pairing is relative to the
   *  argument record, so the parameter list judges it. */
  readonly parameter?: true;
}

const CONTRACT_KEYS = new Set(["inputType", "outputType"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** The schema a contract field or a `use: schema` slot holds inline, or undefined
 *  for a reference, a named type or anything that is no schema. */
function inlineSchemaOf(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.kind === "string") {
    return isResolvedReference(value) || !isPlainObject(value.schema) ? undefined : value.schema;
  }
  return value;
}

/**
 * Every schema `manifest` holds, found by walking its kind's schema and the value
 * in tandem (stamped slots, `use: schema` slots) and the value alone (contract
 * fields). A site is not descended into; an expression or a live value never is.
 */
export function schemaValueSites(
  kindSchema: Record<string, any> | undefined,
  manifest: unknown,
  isExpression: (value: unknown) => boolean,
): SchemaValueSite[] {
  const sites = new Map<string, SchemaValueSite>();
  const add = (role: SchemaRole, path: ValuePath, value: unknown): void => {
    const at = renderValuePath(path);
    if (!sites.has(at)) sites.set(at, { role, path, value });
  };

  if (kindSchema) {
    const entered = new Set<string>();
    const ids = new WeakMap<object, number>();
    let nextId = 0;
    const nodeId = (node: object) => {
      let id = ids.get(node);
      if (id === undefined) ids.set(node, (id = nextId++));
      return id;
    };
    const walk = (node: unknown, value: unknown, path: ValuePath): void => {
      if (!node || typeof node !== "object" || Array.isArray(node) || value === undefined) return;
      if (isExpression(value)) return;
      const declared = node as Record<string, any>;
      const key = `${nodeId(declared)}\0${renderValuePath(path)}`;
      if (entered.has(key)) return;
      entered.add(key);
      const fragment = manifestFragmentOf(declared);
      if (fragment === "KindSchema" || fragment === "JsonSchema7") {
        if (isPlainObject(value)) add(fragment === "KindSchema" ? "kind" : "data", path, value);
        return;
      }
      if (fragment === "CallableParams" && Array.isArray(value)) add("params", path, value);
      const slot = readRefSlot(declared);
      if (slot?.uses.includes("schema")) {
        const inline = inlineSchemaOf(value);
        if (inline) {
          add("data", inline === value ? path : [...path, "schema"], inline);
          return;
        }
      }
      if (typeof declared.$ref === "string" && declared.$ref.startsWith("#")) {
        walk(resolveSchemaPointer(kindSchema, declared.$ref), value, path);
      }
      for (const union of ["oneOf", "anyOf", "allOf"] as const) {
        if (Array.isArray(declared[union])) for (const branch of declared[union]) walk(branch, value, path);
      }
      if (Array.isArray(value)) {
        if (isPlainObject(declared.items)) value.forEach((item, index) => walk(declared.items, item, [...path, index]));
        return;
      }
      if (!isPlainObject(value)) return;
      const properties = isPlainObject(declared.properties) ? declared.properties : {};
      for (const [name, child] of Object.entries(value)) {
        if (name in properties) walk(properties[name], child, [...path, name]);
        else if (isPlainObject(declared.additionalProperties)) walk(declared.additionalProperties, child, [...path, name]);
      }
    };
    walk(kindSchema, manifest, []);
  }

  const contracts = (value: unknown, path: ValuePath): void => {
    if (isExpression(value)) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => contracts(item, [...path, index]));
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (CONTRACT_KEYS.has(key)) {
        const inline = inlineSchemaOf(child);
        if (inline) add("data", inline === child ? [...path, key] : [...path, key, "schema"], inline);
        continue;
      }
      if (SCHEMA_REGION_KEYS.includes(key)) continue;
      contracts(child, [...path, key]);
    }
  };
  contracts(manifest, []);
  const lists = [...sites.values()].filter((site) => site.role === "params").map((site) => renderValuePath(site.path));
  return [...sites.values()].map((site) => {
    if (site.role !== "data" || site.path.length < 2) return site;
    const holder = renderValuePath(site.path.slice(0, -2));
    return lists.includes(holder) && site.path[site.path.length - 1] === "schema" ? { ...site, parameter: true } : site;
  });
}

/** Every JSON Schema subschema keyword a walk follows. Annotation values
 *  (`x-telo-context` and the like) hold schemas of their own and are not part of
 *  the schema they annotate. */
const SUBSCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependencies"] as const;
const SUBSCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "items"] as const;
const SUBSCHEMA_SINGLE = [
  "items",
  "additionalItems",
  "additionalProperties",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
] as const;

/** Every schema node of `schema` with its path below the schema, each node once —
 *  the author's: a reserved fragment definition is not walked. */
export function schemaNodes(schema: unknown): { node: Record<string, unknown>; path: ValuePath }[] {
  const out: { node: Record<string, unknown>; path: ValuePath }[] = [];
  const seen = new Set<object>();
  const visit = (node: unknown, path: ValuePath): void => {
    if (!isPlainObject(node) || seen.has(node)) return;
    seen.add(node);
    out.push({ node, path });
    for (const key of SUBSCHEMA_MAPS) {
      const map = node[key];
      if (!isPlainObject(map)) continue;
      for (const [name, child] of Object.entries(map)) {
        // A reserved definition is the analyzer's copy of a fragment, not the
        // author's schema.
        if ((key === "$defs" || key === "definitions") && isHoistedFragmentDefKey(name)) continue;
        visit(child, [...path, key, name]);
      }
    }
    for (const key of SUBSCHEMA_LISTS) {
      const list = node[key];
      if (Array.isArray(list)) list.forEach((child, index) => visit(child, [...path, key, index]));
    }
    for (const key of SUBSCHEMA_SINGLE) visit(node[key], [...path, key]);
  };
  visit(schema, []);
  return out;
}

/** One text a data schema shows: a `title`, a `description` or a string enum value. */
export interface SchemaText {
  readonly key: string;
  readonly path: ValuePath;
}

const schemaTextMemo = new WeakMap<object, SchemaText[]>();

/** The context `x-telo-text-context` gives a node, when it gives a readable one. */
export function textContextOf(node: Record<string, unknown>): string | null {
  const context = node[TEXT_CONTEXT_ANNOTATION];
  return typeof context === "string" && context !== "" ? context : null;
}

/**
 * Every text a data schema shows, keyed as a catalog entry's source is: the text
 * read as literal words (no placeholders), with the context its node's
 * `x-telo-text-context` gives. Memoized per schema object, so a shape reused at
 * many sites is read once.
 */
export function schemaTexts(schema: unknown): readonly SchemaText[] {
  if (!isPlainObject(schema)) return [];
  const cached = schemaTextMemo.get(schema);
  if (cached) return cached;
  const out: SchemaText[] = [];
  const keyOf = (text: string, context: string | null) =>
    textKey(serializePattern(text === "" ? [] : [text]), context);
  for (const { node, path } of schemaNodes(schema)) {
    const context = textContextOf(node);
    // A fragment's own title and description are Telo's words, not the module's.
    const ownWords = manifestFragmentOf(node) === undefined;
    if (ownWords && typeof node.title === "string") {
      out.push({ key: keyOf(node.title, context), path: [...path, "title"] });
    }
    if (ownWords && typeof node.description === "string") {
      out.push({ key: keyOf(node.description, context), path: [...path, "description"] });
    }
    if (Array.isArray(node.enum)) {
      node.enum.forEach((value, index) => {
        if (typeof value === "string") out.push({ key: keyOf(value, context), path: [...path, "enum", index] });
      });
    }
  }
  schemaTextMemo.set(schema, out);
  return out;
}

/** A problem with one of the two text annotations, below the schema it is in. */
export interface TextAnnotationProblem {
  readonly code: "SCHEMA_VIOLATION" | "TEXT_VALUES_FOR_INVALID";
  readonly message: string;
  readonly path: ValuePath;
}

function shapeProblem(annotation: string, value: unknown, path: ValuePath): TextAnnotationProblem | undefined {
  if (annotation === TEXT_CONTEXT_ANNOTATION) {
    if (typeof value === "string" && value !== "") return undefined;
    return {
      code: "SCHEMA_VIOLATION",
      message:
        typeof value === "string"
          ? `${annotation} must NOT have fewer than 1 characters: an empty context is written by leaving the annotation out`
          : `${annotation} must be string: the context of this node's title, description and enum labels`,
      path: [...path, annotation],
    };
  }
  if (typeof value === "string" && value.startsWith("/")) return undefined;
  return {
    code: "SCHEMA_VIOLATION",
    message:
      typeof value === "string"
        ? `${annotation} must match pattern "^/": a JSON Pointer, relative to the enclosing value, to the Text these values bind`
        : `${annotation} must be string: a JSON Pointer, relative to the enclosing value, to the Text these values bind`,
    path: [...path, annotation],
  };
}

/** A node's own properties map, after a document-local `$ref`. */
function propertiesOf(node: unknown, root: Record<string, unknown>): Record<string, unknown> | undefined {
  let at = node;
  for (let hops = 0; hops < 32 && isPlainObject(at) && typeof at.$ref === "string" && at.$ref.startsWith("#"); hops++) {
    at = resolveSchemaPointer(root as Record<string, any>, at.$ref);
  }
  return isPlainObject(at) && isPlainObject(at.properties) ? at.properties : undefined;
}

function declaresObject(node: Record<string, unknown>): boolean {
  const type = node.type;
  return type === "object" || (Array.isArray(type) && type.includes("object"));
}

/** Follow a pointer's segments through `properties`, from `start`. */
function schemaAt(start: unknown, segments: readonly string[], root: Record<string, unknown>): unknown {
  let at: unknown = start;
  for (const segment of segments) {
    const properties = propertiesOf(at, root);
    if (!properties || !(segment in properties)) return undefined;
    at = properties[segment];
  }
  return at;
}

function isTextNode(node: unknown, root: Record<string, unknown>): boolean {
  if (isTextSchema(node)) return true;
  if (isPlainObject(node) && typeof node.$ref === "string" && node.$ref.startsWith("#")) {
    return isTextSchema(resolveSchemaPointer(root as Record<string, any>, node.$ref));
  }
  return false;
}

/**
 * What is wrong with the two text annotations inside one schema the manifest
 * holds: each value's shape (`SCHEMA_VIOLATION`, `x-telo-text-context` read on a
 * data schema only), and each values pairing's relations
 * (`TEXT_VALUES_FOR_INVALID` — the annotated node holds no object, its pointer
 * names nothing or names no `Text`, or two nodes pair with one `Text`).
 */
export function textAnnotationProblems(site: SchemaValueSite): TextAnnotationProblem[] {
  const problems: TextAnnotationProblem[] = [];
  if (site.role === "params") return paramsValuesForProblems(site.value);
  const root = site.value as Record<string, unknown>;
  const paired = new Map<string, ValuePath>();
  const check = (node: Record<string, unknown>, path: ValuePath, enclosing: Record<string, unknown> | undefined) => {
    if (site.role === "data" && TEXT_CONTEXT_ANNOTATION in node) {
      const problem = shapeProblem(TEXT_CONTEXT_ANNOTATION, node[TEXT_CONTEXT_ANNOTATION], path);
      if (problem) problems.push(problem);
    }
    if (!(TEXT_VALUES_FOR_ANNOTATION in node)) return;
    if (site.parameter && path.length === 0) return;
    const pointer = node[TEXT_VALUES_FOR_ANNOTATION];
    const shape = shapeProblem(TEXT_VALUES_FOR_ANNOTATION, pointer, path);
    if (shape) {
      problems.push(shape);
      return;
    }
    const at = [...path, TEXT_VALUES_FOR_ANNOTATION];
    const relation = (message: string) => problems.push({ code: "TEXT_VALUES_FOR_INVALID", message, path: at });
    if (!declaresObject(node)) {
      relation(`${TEXT_VALUES_FOR_ANNOTATION} is on a node that holds no object: a message's values are an object keyed by placeholder name`);
      return;
    }
    const segments = pointerSegments(pointer)!;
    const target = enclosing ? schemaAt(enclosing, segments, root) : undefined;
    if (target === undefined) {
      relation(`${TEXT_VALUES_FOR_ANNOTATION}: '${pointer as string}' names nothing beside this field — the pointer is relative to the object holding it`);
      return;
    }
    if (!isTextNode(target, root)) {
      relation(`${TEXT_VALUES_FOR_ANNOTATION}: '${pointer as string}' names a field that is not typed by the Text fragment`);
      return;
    }
    const targetKey = `${renderValuePath(path.slice(0, -2))}\0${pointer as string}`;
    const first = paired.get(targetKey);
    if (first) {
      relation(`${TEXT_VALUES_FOR_ANNOTATION}: '${pointer as string}' is already paired with the values at '${renderValuePath(first)}' — a Text binds one set of values`);
      return;
    }
    paired.set(targetKey, path);
  };
  for (const { node, path } of schemaNodes(root)) {
    // The object a field's annotation is relative to: the node whose `properties`
    // holds it.
    const parentPath = path.length >= 2 && path[path.length - 2] === "properties" ? path.slice(0, -2) : undefined;
    const enclosing = parentPath ? (nodeAt(root, parentPath) as Record<string, unknown> | undefined) : undefined;
    check(node, path, enclosing);
  }
  return problems;
}

function nodeAt(root: unknown, path: ValuePath): unknown {
  let at = root;
  for (const segment of path) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string | number, unknown>)[segment];
  }
  return at;
}

/** The values pairings of a callable's parameter list: a pointer's first segment
 *  names a parameter, the rest descends into its schema's properties. */
function paramsValuesForProblems(params: unknown): TextAnnotationProblem[] {
  if (!Array.isArray(params)) return [];
  const problems: TextAnnotationProblem[] = [];
  const byName = new Map<string, Record<string, unknown>>();
  for (const param of params) {
    if (isPlainObject(param) && typeof param.name === "string" && isPlainObject(param.schema)) {
      byName.set(param.name, param.schema);
    }
  }
  const paired = new Map<string, number>();
  params.forEach((param, index) => {
    if (!isPlainObject(param) || !isPlainObject(param.schema)) return;
    const schema = param.schema;
    if (!(TEXT_VALUES_FOR_ANNOTATION in schema)) return;
    const path: ValuePath = [index, "schema"];
    const pointer = schema[TEXT_VALUES_FOR_ANNOTATION];
    const shape = shapeProblem(TEXT_VALUES_FOR_ANNOTATION, pointer, path);
    if (shape) {
      problems.push(shape);
      return;
    }
    const at = [...path, TEXT_VALUES_FOR_ANNOTATION];
    const relation = (message: string) => problems.push({ code: "TEXT_VALUES_FOR_INVALID", message, path: at });
    if (!declaresObject(schema)) {
      relation(`${TEXT_VALUES_FOR_ANNOTATION} is on a parameter that holds no object: a message's values are an object keyed by placeholder name`);
      return;
    }
    const segments = pointerSegments(pointer)!;
    const named = segments.length === 1 ? byName.get(segments[0]!) : undefined;
    if (named === undefined) {
      relation(`${TEXT_VALUES_FOR_ANNOTATION}: '${pointer as string}' names no parameter — the pointer is relative to the call's arguments, keyed by parameter name, and names the Text parameter itself`);
      return;
    }
    if (!isTextNode(named, named)) {
      relation(`${TEXT_VALUES_FOR_ANNOTATION}: '${pointer as string}' names a parameter that is not typed by the Text fragment`);
      return;
    }
    const earlier = paired.get(pointer as string);
    if (earlier !== undefined) {
      relation(`${TEXT_VALUES_FOR_ANNOTATION}: '${pointer as string}' is already paired with parameter ${earlier} — a Text binds one set of values`);
      return;
    }
    paired.set(pointer as string, index);
  });
  return problems;
}

/** One callable parameter typed `Text`, and the parameter holding its values. */
export interface TextParameter {
  readonly index: number;
  readonly name: string;
  /** The parameter whose `x-telo-text-values-for` names this one, if any. */
  readonly values?: { readonly index: number; readonly name: string };
}

/** The `Text` parameters of a parameter list, each with its paired values. */
export function textParameters(params: readonly { name?: unknown; schema?: unknown }[] | undefined): TextParameter[] {
  if (!params) return [];
  const out: TextParameter[] = [];
  params.forEach((param, index) => {
    if (typeof param.name !== "string" || !isTextSchema(param.schema)) return;
    const pairedAt = params.findIndex((other) => {
      const segments = isPlainObject(other.schema) ? pointerSegments(other.schema[TEXT_VALUES_FOR_ANNOTATION]) : undefined;
      return segments?.length === 1 && segments[0] === param.name;
    });
    const paired = pairedAt === -1 ? undefined : params[pairedAt]!;
    out.push({
      index,
      name: param.name,
      ...(paired && typeof paired.name === "string" ? { values: { index: pairedAt, name: paired.name } } : {}),
    });
  });
  return out;
}

/** Every object node in `value` carrying `x-telo-text-context`, with its path —
 *  read for the placement warning. Plain containers only. */
export function textContextNodes(value: unknown, path: ValuePath = []): { node: object; path: ValuePath }[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => textContextNodes(item, [...path, index]));
  if (!isPlainObject(value)) return [];
  const own = TEXT_CONTEXT_ANNOTATION in value ? [{ node: value, path }] : [];
  return [...own, ...Object.entries(value).flatMap(([key, child]) => textContextNodes(child, [...path, key]))];
}
