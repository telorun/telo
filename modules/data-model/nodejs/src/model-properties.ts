import type { JsonSchema } from "./collection-types.js";

const SCALARS = ["string", "number", "integer", "boolean"];
const ORDERED = ["string", "number", "integer"];

/** One property a collection can be read by, and the plain JSON types its values take. */
export interface ModelProperty {
  name: string;
  /** No types means the model declares none. */
  types: string[];
  /** The shape accepts `null` for it: its `type` admits it, or it declares no
   *  `type` and no listed value that leaves `null` out. */
  nullable: boolean;
  required: boolean;
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

/** Every property a shape declares, by name, in declaration order. */
export function modelProperties(schema: JsonSchema): Map<string, ModelProperty> {
  const properties = new Map<string, ModelProperty>();
  const required: unknown[] = Array.isArray(schema.required) ? schema.required : [];
  for (const [name, declared] of Object.entries((schema.properties ?? {}) as Record<string, JsonSchema>)) {
    properties.set(name, {
      name,
      types: declaredTypes(declared ?? {}),
      nullable: admitsNull(declared ?? {}),
      required: required.includes(name),
    });
  }
  return properties;
}

const untyped = (property: ModelProperty) => property.types.length === 0;

export const isScalar = (property: ModelProperty) =>
  untyped(property) || property.types.some((type) => SCALARS.includes(type));
export const isText = (property: ModelProperty) => untyped(property) || property.types.includes("string");
export const isOrdered = (property: ModelProperty) =>
  untyped(property) || property.types.some((type) => ORDERED.includes(type));

/** A property's declared `type`, `null` aside. */
const typeOf = (property: JsonSchema): string[] =>
  property.type === undefined ? [] : [property.type].flat().filter((type: string) => type !== "null");

/** The types a relation's value takes: the property's, or its items' for a list. */
export function relationValueTypes(schema: JsonSchema, name: string): string[] {
  const property = (schema.properties ?? {})[name] as JsonSchema | undefined;
  if (!property) return [];
  const plain = typeOf(property);
  if (plain.length === 1 && plain[0] === "array" && property.items && typeof property.items === "object") {
    return typeOf(property.items);
  }
  return plain;
}
