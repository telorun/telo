import { integerInput } from "@telorun/sdk";

export type JsonSchema = Record<string, any>;

const SCALARS = ["string", "number", "integer", "boolean"];
const ORDERED = ["string", "number", "integer"];

/** One property a collection can be read by: its API name, its column, and the
 *  plain JSON types its values take. No types means the model declares none. */
export interface ModelProperty {
  name: string;
  column: string;
  types: string[];
  /** The shape accepts `null` for it: its `type` admits it, or it declares no
   *  `type` and no listed value that leaves `null` out. */
  nullable: boolean;
  /** Listed in the model's `required`. */
  required: boolean;
}

/** `dueDate` → `due_date`: the column a camelCase property is stored in. */
export function columnOf(property: string): string {
  return property.replace(/([A-Z])/g, "_$1").toLowerCase();
}

function typeOfValue(value: unknown): string | undefined {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return undefined;
}

function declaredTypes(property: JsonSchema): string[] {
  if (property.type !== undefined) return [property.type].flat().filter((type: string) => type !== "null");
  if (!Array.isArray(property.enum)) return [];
  const listed = property.enum.map(typeOfValue).filter((type): type is string => type !== undefined);
  return [...new Set(listed)];
}

function admitsNull(property: JsonSchema): boolean {
  if (property.type !== undefined) return [property.type].flat().includes("null");
  if (Array.isArray(property.enum)) return property.enum.includes(null);
  return !("const" in property) || property.const === null;
}

/**
 * Every property a shape declares, by API name, in declaration order. Nothing
 * else ever becomes a column.
 */
export function modelProperties(schema: JsonSchema): Map<string, ModelProperty> {
  const properties = new Map<string, ModelProperty>();
  const required: unknown[] = Array.isArray(schema.required) ? schema.required : [];
  for (const [name, declared] of Object.entries((schema.properties ?? {}) as Record<string, JsonSchema>)) {
    const type = declared?.type;
    properties.set(name, {
      name,
      column: columnOf(name),
      types: declaredTypes(declared ?? {}),
      nullable: admitsNull(declared ?? {}),
      required: required.includes(name),
    });
  }
  return properties;
}

const untyped = (property: ModelProperty) => property.types.length === 0;

export function isScalar(property: ModelProperty): boolean {
  return untyped(property) || property.types.some((type) => SCALARS.includes(type));
}

export function isText(property: ModelProperty): boolean {
  return untyped(property) || property.types.includes("string");
}

export function isOrdered(property: ModelProperty): boolean {
  return untyped(property) || property.types.some((type) => ORDERED.includes(type));
}

const NOT_READ = Symbol("not read");

function readAs(type: string, raw: unknown): unknown {
  const text = typeof raw === "string" ? raw.trim() : undefined;
  if (type === "integer") {
    const integer = text !== undefined && /^-?\d+$/.test(text) ? Number(text) : integerInput(raw);
    return integer !== undefined && Number.isSafeInteger(integer) ? integer : NOT_READ;
  }
  if (type === "number") {
    const number = text !== undefined && text !== "" ? Number(text) : typeof raw === "bigint" ? Number(raw) : raw;
    return typeof number === "number" && Number.isFinite(number) ? number : NOT_READ;
  }
  if (type === "boolean") {
    if (typeof raw === "boolean") return raw;
    return text === "true" ? true : text === "false" ? false : NOT_READ;
  }
  return typeof raw === "string" ? raw : NOT_READ;
}

/**
 * A value as the property's model type reads it — given already typed, or as
 * the text a query string carries. `undefined` when no declared type reads it.
 */
export function readValue(property: ModelProperty, raw: unknown, among: string[] = SCALARS): unknown {
  if (untyped(property)) {
    return typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" ? raw : undefined;
  }
  // Narrowest first, so `"12"` is the integer where a property takes both.
  for (const type of ["integer", "number", "boolean", "string"]) {
    if (!property.types.includes(type) || !among.includes(type)) continue;
    const value = readAs(type, raw);
    if (value !== NOT_READ) return value;
  }
  return undefined;
}

/** {@link readValue} for a comparison, which no boolean takes part in. */
export function readOrderedValue(property: ModelProperty, raw: unknown): unknown {
  return readValue(property, raw, ORDERED);
}

/**
 * A stored value in the property's declared JSON type. Engines differ in what
 * they hand back — SQLite keeps a boolean as 0 / 1, PostgreSQL returns a wide
 * integer as text — and a row has one encoding whichever is behind it.
 */
export function decodeValue(property: ModelProperty, stored: unknown): unknown {
  if (stored === null || stored === undefined) return null;
  const numeric = property.types.includes("integer") || property.types.includes("number");
  if (property.types.includes("boolean") && !numeric) {
    if (typeof stored === "number" || typeof stored === "bigint") return Number(stored) !== 0;
    return stored;
  }
  if (numeric && !property.types.includes("string")) {
    if (typeof stored === "bigint") return Number(stored);
    if (typeof stored === "string" && stored.trim() !== "" && Number.isFinite(Number(stored))) return Number(stored);
  }
  return stored;
}

const EMPTY_VALUES: Record<string, () => unknown> = {
  string: () => "",
  integer: () => 0,
  number: () => 0,
  boolean: () => false,
  array: () => [],
  object: () => ({}),
};

/** The property identifying a row. */
export const KEY = "id";

/**
 * A stored row as a record valid against the shape. A column holding NULL is
 * `null` where the property admits it, left out where the property is
 * optional, and the empty value of its first declared type where it is
 * required — the type's, whatever further constraint the model puts on it.
 */
export function decodeRow(properties: Map<string, ModelProperty>, row: Record<string, unknown>): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const property of properties.values()) {
    const value = decodeValue(property, row[property.name]);
    if (value !== null || property.nullable) decoded[property.name] = value;
    else if (property.required) decoded[property.name] = EMPTY_VALUES[property.types[0]]?.() ?? null;
  }
  return decoded;
}
