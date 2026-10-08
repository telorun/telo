export type JsonSchema = Record<string, any>;

/** The types a schema declares, `null` aside: a nullable boolean is a boolean. */
export const plainTypes = (schema: JsonSchema): string[] => [schema.type ?? []].flat().filter((type: string) => type !== "null");

export interface Finding {
  /** Member names from the value's root to what failed. */
  path: string[];
  message: string;
}

const typeOf = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;

const fitsType = (value: unknown, type: string): boolean =>
  typeOf(value) === type || (type === "number" && typeof value === "number");

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Check a value against a JSON Schema, interpreting the schema as data — no
 * code is generated. Reads `type`, `required`, `enum`, `const`, the string
 * lengths and `pattern`, the numeric bounds and `multipleOf`, through
 * `properties` and, for a list, on each of its items through `items`. Every
 * other keyword is left to the API.
 */
export function validate(schema: JsonSchema, value: unknown, path: string[] = []): Finding[] {
  const findings: Finding[] = [];
  const fail = (message: string) => findings.push({ path, message });
  if (schema.type !== undefined && ![schema.type].flat().some((type: string) => fitsType(value, type))) {
    fail(`Must be ${[schema.type].flat().join(" or ")}`);
    return findings;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed: unknown) => equal(allowed, value))) {
    fail(`Must be one of: ${schema.enum.join(", ")}`);
  }
  if ("const" in schema && !equal(schema.const, value)) fail(`Must be ${JSON.stringify(schema.const)}`);
  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) fail(`Must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && length > schema.maxLength) fail(`Must be at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) fail("Is not in the expected format");
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`Must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`Must be at most ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) fail(`Must be greater than ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) fail(`Must be less than ${schema.exclusiveMaximum}`);
    if (schema.multipleOf !== undefined && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) {
      fail(`Must be a multiple of ${schema.multipleOf}`);
    }
  }
  if (Array.isArray(value) && schema.items !== null && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    value.forEach((item, index) => findings.push(...validate(schema.items, item, [...path, String(index)])));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const members = value as Record<string, unknown>;
    for (const name of (schema.required ?? []) as string[]) {
      if (members[name] === undefined) findings.push({ path: [...path, name], message: "Is required" });
    }
    for (const [name, member] of Object.entries((schema.properties ?? {}) as Record<string, JsonSchema>)) {
      if (members[name] !== undefined) findings.push(...validate(member, members[name], [...path, name]));
    }
  }
  return findings;
}
