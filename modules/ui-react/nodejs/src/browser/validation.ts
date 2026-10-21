import type { WordCall } from "./ui-error.js";

export type JsonSchema = Record<string, any>;

/** The types a schema declares, `null` aside: a nullable boolean is a boolean. */
export const plainTypes = (schema: JsonSchema): string[] => [schema.type ?? []].flat().filter((type: string) => type !== "null");

export interface Finding {
  /** Member names from the value's root to what failed. */
  path: string[];
  /** What failed, as the word named after the keyword that refused it. */
  word: WordCall;
}

const typeOf = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;

const fitsType = (value: unknown, type: string): boolean =>
  typeOf(value) === type || (type === "number" && typeof value === "number");

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** JSON equality: by value, objects in any key order. */
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => equal(item, b[i]));
  }
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

const show = (value: unknown) => JSON.stringify(value);

/**
 * Check a value against a schema in the interpreted profile — `type`, `const`,
 * `enum`, `not`, `allOf`, `anyOf`, `required`, `properties`, `items`, the list
 * and string lengths, `uniqueItems`, `pattern` and the numeric bounds —
 * interpreting the schema as data; no code is generated. Every other keyword
 * is left to the API. One evaluator answers both a condition and a form's
 * validation, so the two cannot disagree about what a keyword means.
 */
export function validate(schema: JsonSchema, value: unknown, path: string[] = []): Finding[] {
  const findings: Finding[] = [];
  const fail = (id: string, values?: WordCall["values"]) => findings.push({ path, word: values ? { id, values } : { id } });
  if (schema.type !== undefined && ![schema.type].flat().some((type: string) => fitsType(value, type))) {
    fail("type", { types: [schema.type].flat().join(", ") });
    return findings;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed: unknown) => equal(allowed, value))) {
    fail("enum", { allowed: schema.enum.map((allowed: unknown) => (typeof allowed === "string" ? allowed : show(allowed))).join(", ") });
  }
  if ("const" in schema && !equal(schema.const, value)) fail("const", { value: show(schema.const) });
  if (schema.not !== undefined && validate(schema.not, value, path).length === 0) fail("not");
  for (const member of (Array.isArray(schema.allOf) ? schema.allOf : []) as JsonSchema[]) findings.push(...validate(member, value, path));
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((member: JsonSchema) => validate(member, value, path).length === 0)) {
    fail("anyOf");
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) fail("minLength", { limit: schema.minLength });
    if (schema.maxLength !== undefined && length > schema.maxLength) fail("maxLength", { limit: schema.maxLength });
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) fail("pattern");
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) fail("minimum", { limit: schema.minimum });
    if (schema.maximum !== undefined && value > schema.maximum) fail("maximum", { limit: schema.maximum });
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) fail("exclusiveMinimum", { limit: schema.exclusiveMinimum });
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) fail("exclusiveMaximum", { limit: schema.exclusiveMaximum });
    if (schema.multipleOf !== undefined && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) {
      fail("multipleOf", { limit: schema.multipleOf });
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail("minItems", { limit: schema.minItems });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail("maxItems", { limit: schema.maxItems });
    if (schema.uniqueItems === true && value.some((item, i) => value.findIndex((other) => equal(other, item)) !== i)) {
      fail("uniqueItems");
    }
    if (isObject(schema.items)) value.forEach((item, index) => findings.push(...validate(schema.items, item, [...path, String(index)])));
  }
  if (isObject(value)) {
    for (const name of (schema.required ?? []) as string[]) {
      if (value[name] === undefined) findings.push({ path: [...path, name], word: { id: "required" } });
    }
    for (const [name, member] of Object.entries((schema.properties ?? {}) as Record<string, JsonSchema>)) {
      if (value[name] !== undefined) findings.push(...validate(member, value[name], [...path, name]));
    }
  }
  return findings;
}

/** A value the place a condition reads may hold — or nothing there at all. */
export type Read = { present: true; value: unknown } | { present: false };

/** Whether a condition holds: a missing value never satisfies one, even under
 *  `not`; `null` is a value. */
export function holds(matches: JsonSchema, read: Read): boolean {
  return read.present && validate(matches, read.value).length === 0;
}
