import { RuntimeError, type ResourceContext } from "@telorun/sdk";

export type JsonSchema = Record<string, any>;

const SCALARS = new Set(["string", "number", "integer", "boolean"]);

// The same reading as `modelSchema` in modules/crud/nodejs/src/model-schema.ts; keep the two alike.
/** The JSON Schema a `model:` slot names — a live shape, an inline declaration,
 *  a reference the registry holds, or a schema written in place. */
export function modelSchema(model: unknown, ctx: ResourceContext, owner: string): JsonSchema {
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
  throw new RuntimeError("ERR_REF_UNRESOLVED", `${owner}: 'model' does not name a data shape.`);
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

export function labelOf(name: string, property: JsonSchema | undefined): string {
  return typeof property?.title === "string" ? property.title : name;
}

/** The schema a path of member names reaches, or `undefined` past its end. */
export function schemaAt(schema: JsonSchema, path: string[]): JsonSchema | undefined {
  let current: JsonSchema | undefined = schema;
  for (const key of path) current = current?.properties?.[key];
  return current;
}
