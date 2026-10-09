import { RuntimeError, type ResourceContext } from "@telorun/sdk";

export type JsonSchema = Record<string, any>;

const SCALARS = new Set(["string", "number", "integer", "boolean"]);

// The same reading as `modelSchema` in modules/crud/nodejs/src/model-schema.ts; keep the two alike.
/** The JSON Schema a `model:` slot names — a live shape, an inline declaration,
 *  a reference the registry holds, or a schema written in place. */
export function modelSchema(model: unknown, ctx: ResourceContext, owner: string, slot = "model"): JsonSchema {
  if (model && typeof model === "object") {
    const value = model as Record<string, any>;
    if (value.schema && typeof value.schema === "object") return value.schema;
    const key = typeof value.$ref === "string" ? value.$ref : value.name;
    if (typeof key === "string") {
      const found = ctx.lookupSchema(key);
      if (found) return found as JsonSchema;
    } else if (value.type || value.properties) {
      return value;
    }
  }
  throw new RuntimeError("ERR_REF_UNRESOLVED", `${owner}: '${slot}' does not name a data shape.`);
}

/** The model's properties in declaration order. */
export function propertiesOf(schema: JsonSchema): [string, JsonSchema][] {
  return Object.entries((schema.properties ?? {}) as Record<string, JsonSchema>);
}

/** A property's declared types, `null` aside. */
export function plainTypes(property: JsonSchema): string[] {
  const declared = property.type === undefined ? [] : [property.type].flat();
  return declared.filter((type: string) => type !== "null");
}

/** Holds one plain value: a string, a number, a boolean, or one of a listed set. */
export function isScalar(property: JsonSchema): boolean {
  const types = plainTypes(property);
  if (types.length === 0) return Array.isArray(property.enum);
  return types.every((type) => SCALARS.has(type));
}

/** What a form control can enter: one plain value, or a list of them. The one
 *  definition every form's default field set and field check read. */
export function isEnterable(property: JsonSchema): boolean {
  if (isScalar(property)) return true;
  const types = plainTypes(property);
  const items = property.items;
  return types.length === 1 && types[0] === "array" && items !== null && typeof items === "object" && !Array.isArray(items) && isScalar(items);
}

/** One field per property a control can enter, in declaration order. */
export function enterableFields(schema: JsonSchema): { property: string; label: string }[] {
  return propertiesOf(schema)
    .filter(([, property]) => isEnterable(property))
    .map(([name, property]) => ({ property: name, label: labelOf(name, property) }));
}

/** A schema node read as the shape it names: the keywords written beside a
 *  reference first, then the shape it names, each with the document its own
 *  local pointers resolve in. */
export type Shape = { schema: JsonSchema; root: JsonSchema }[];

/** Who is reading, for a reference that cannot be followed. */
export interface ShapeReader {
  ctx: ResourceContext;
  owner: string;
}

function isNode(value: unknown): value is JsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function atPointer(root: JsonSchema, pointer: string): unknown {
  let current: unknown = root;
  for (const token of pointer.split("/").slice(1)) {
    if (current === null || typeof current !== "object") return undefined;
    let decoded: string;
    try {
      decoded = decodeURIComponent(token);
    } catch (error) {
      // A token that is no URI text names nothing.
      if (error instanceof URIError) return undefined;
      throw error;
    }
    const key = decoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Follows every `$ref` `node` holds — a registered shape, a pointer into its
 *  own document — to the shape it names. */
function shapeOf(node: unknown, root: JsonSchema, reader: ShapeReader, at: string): Shape {
  const shape: Shape = [];
  const open: { root: JsonSchema; key: string }[] = [];
  let current = node;
  let document = root;
  while (isNode(current)) {
    const key: unknown = current.$ref;
    if (typeof key !== "string") {
      shape.push({ schema: current, root: document });
      break;
    }
    if (open.some((entry) => entry.key === key && (!key.startsWith("#") || entry.root === document))) {
      throw new RuntimeError(
        "ERR_REF_UNRESOLVED",
        `${reader.owner}: '${at}' holds a reference ('${key}') that leads back to itself, so it names no data shape. Point it at a shape that does not lead back here.`,
      );
    }
    open.push({ root: document, key });
    const { $ref: followed, ...beside } = current;
    shape.push({ schema: beside, root: document });
    const hash = key.indexOf("#");
    const name = hash < 0 ? key : key.slice(0, hash);
    const named = name === "" ? document : reader.ctx.lookupSchema(name);
    const target = isNode(named) ? atPointer(named, hash < 0 ? "" : key.slice(hash + 1)) : undefined;
    if (!isNode(target) && typeof target !== "boolean") {
      throw new RuntimeError(
        "ERR_REF_UNRESOLVED",
        `${reader.owner}: '${at}' holds a reference ('${key}') that does not name a data shape. Declare that shape, or correct the reference.`,
      );
    }
    current = target;
    document = named as JsonSchema;
  }
  return shape;
}

/** A keyword of the shape, with the document its value's pointers resolve in. */
function keywordOf(shape: Shape, keyword: string): { value: unknown; root: JsonSchema } | undefined {
  for (const { schema, root } of shape) if (schema[keyword] !== undefined) return { value: schema[keyword], root };
  return undefined;
}

/** The shape a model slot's schema is. `at` names the slot. */
export function modelShape(schema: JsonSchema, reader: ShapeReader, at: string): Shape {
  return shapeOf(schema, schema, reader, at);
}

/** The shape a path of member names reaches, or `undefined` past its end.
 *  `at` names where `from` sits, for a reference that cannot be followed. */
export function schemaAt(from: Shape, path: string[], reader: ShapeReader, at: string): Shape | undefined {
  let current = from;
  let where = at;
  for (const key of path) {
    const properties = keywordOf(current, "properties");
    if (!properties || !isNode(properties.value) || !Object.hasOwn(properties.value, key)) return undefined;
    where = `${where}.${key}`;
    current = shapeOf(properties.value[key], properties.root, reader, where);
  }
  return current;
}

/** The shape of a list's elements, or `undefined` where it declares none. */
export function itemsOf(list: Shape, reader: ShapeReader, at: string): Shape | undefined {
  const items = keywordOf(list, "items");
  return items && isNode(items.value) ? shapeOf(items.value, items.root, reader, `${at}.items`) : undefined;
}

/** What the model says about a value, which decides how it is shown. */
export function presentation(target: Shape | undefined): JsonSchema | undefined {
  if (!target) return undefined;
  const present: JsonSchema = {};
  for (const key of ["type", "format"]) {
    const found = keywordOf(target, key);
    if (found) present[key] = found.value;
  }
  return Object.keys(present).length > 0 ? present : undefined;
}

/** A member's title where its shape gives one, else its name. */
export function headerOf(name: string, target: Shape | undefined): string {
  const title = target && keywordOf(target, "title")?.value;
  return typeof title === "string" ? title : name;
}

export function labelOf(name: string, property: JsonSchema | undefined): string {
  return typeof property?.title === "string" ? property.title : name;
}
