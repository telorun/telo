import type { CelEnvironment } from "@telorun/cel";
import {
  celTypeOfValueType,
  PLAIN_ENCODINGS,
  VALUE_TYPES,
  valueBrandBases,
  valueTypeOf,
  type ValueTypeEntry,
} from "@telorun/sdk";

/**
 * Register the CEL face of every value type, from the entries alone — one registration,
 * made where the dialect environment is built, so the runtime environment and every
 * analyzer clone carry the same types and no type is named here.
 *
 * - **A nominal brand** (a `json` entry with no `celType`) is a type of its own over its
 *   base: it converts to its base with the base's own conversion (`int(ports.http)`,
 *   `string(variables.dataDir)`), renders as text (`string(ports.http)`), and — for a host
 *   path — is extended with `.joinPath(relative)` and stays one. Declared, not
 *   implemented: at runtime a branded value IS its base, so the standard library's own
 *   overloads are what evaluate.
 * - **An instance declaring `members`** is a type whose values carry its own type key, so
 *   its members are the type's FIELDS, read by `.`, `.?` and `has()` through the engine's
 *   member-read seam, and `string(value)` is its plain encoding's text — a conversion
 *   registered WITH that encoder as its implementation, dispatched on the value's key.
 */
export function registerValueTypes(environment: CelEnvironment): void {
  for (const [brand, base] of Object.entries(valueBrandBases())) {
    const conversions = [`${base}(Self): ${base}`];
    // Every base CEL can render as text renders its brand too — the runtime value IS the
    // base — so `string(ports.http)` and a port in an `!interpolate` hole convert as the
    // integer they are.
    if (base !== "string") conversions.push("string(Self): string");
    const fromHost = VALUE_TYPES.get(brand)?.fromHost !== undefined;
    environment.registerType({
      name: brand,
      base,
      conversions,
      ...(fromHost ? { members: ["Self.joinPath(string): Self"] } : {}),
    });
  }
  for (const entry of VALUE_TYPES.values()) {
    if (entry.members === undefined) continue;
    const name = celTypeOfValueType(entry);
    const encoding = PLAIN_ENCODINGS[entry.encoding!]!;
    environment.registerType({ name, base: "dyn", fields: fieldTypes(entry), description: entry.description });
    environment.registerFunction(`string(${name}): string`, {
      implementation: (ctx, value) => encoding.encode(value),
      description: `The text of a ${name}, in its plain encoding.`,
    });
  }
}

/** Each member of an entry as the CEL type its field reads as. */
function fieldTypes(entry: ValueTypeEntry): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entry.members!).map(([member, schema]) => [member, celTypeOfSchema(schema)]),
  );
}

/** The CEL type a member's schema declares: a value type's own, a scalar's, a list's
 *  element and a map's value read in turn; anything else `dyn`. */
function celTypeOfSchema(schema: Readonly<Record<string, unknown>>): string {
  const entry = valueTypeOf(schema);
  if (entry) return celTypeOfValueType(entry);
  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
      return "int";
    case "number":
      return "double";
    case "boolean":
      return "bool";
    case "array": {
      const items = schema.items;
      return items && typeof items === "object" && !Array.isArray(items)
        ? `list<${celTypeOfSchema(items as Record<string, unknown>)}>`
        : "list<dyn>";
    }
    case "object": {
      const values = schema.additionalProperties;
      return values && typeof values === "object"
        ? `map<string, ${celTypeOfSchema(values as Record<string, unknown>)}>`
        : "map<string, dyn>";
    }
    default:
      return "dyn";
  }
}
