import type { Operator } from "./collection.js";
import { filterKey, type Values } from "./filter-state.js";
import { separated } from "./separated.js";
import { plainTypes, type JsonSchema } from "./validation.js";

/** A filter as a typed token reads it: what the node says of it, and nothing of any request. */
export interface TokenField {
  property: string;
  operator: Operator;
  schema: JsonSchema;
  /** What each listed value is shown as, in the viewer's language. */
  labels: { value: unknown; label: string }[];
  /** Its values are records of another collection, chosen and never typed. */
  relation: boolean;
}

/** Why a token is not a value: the bar has no filter on the property, no filter
 *  of it takes the operator, or the value is not one the filter holds. */
export type TokenReason = "unknown-property" | "operator-unsupported" | "value-not-listed" | "value-invalid";

export type TokenReading =
  /** No field named: the text is only text. */
  | { kind: "text" }
  /** A field and its operator named, no value yet. */
  | { kind: "open"; field: number }
  /** A relation's field named: the rest is the query for its records, never a value. */
  | { kind: "query"; field: number; query: string }
  /** A whole token: the values its filter would hold. */
  | { kind: "token"; field: number; values: string[] }
  | { kind: "invalid"; reason: TokenReason; field?: number };

const TOKEN = /^([A-Za-z_][A-Za-z0-9_]*)(>=|<=|>|<|:|=)/;

/** The operators each spelling picks among, in order of preference. */
const PICKS: Record<string, Operator[]> = {
  ":": ["contains", "in", "eq"],
  "=": ["in", "eq"],
  ">": ["gt"],
  ">=": ["gte"],
  "<": ["lt"],
  "<=": ["lte"],
};

/** The index of the filter on `name` that `spelling` picks, ignoring the property's case. */
function pick(fields: TokenField[], name: string, spelling: string): { named: boolean; field?: number } {
  const same = fields.flatMap((field, index) => (field.operator !== "absent" && field.property.toLowerCase() === name.toLowerCase() ? [index] : []));
  for (const operator of PICKS[spelling]) {
    const found = same.find((index) => fields[index].operator === operator);
    if (found !== undefined) return { named: true, field: found };
  }
  return { named: same.length > 0 };
}

/** The spelling that picks `fields[index]` among the filters on its property. */
export function spellingOf(fields: TokenField[], index: number): string {
  const field = fields[index];
  const same = fields.filter((other) => other.property === field.property).map((other) => other.operator);
  switch (field.operator) {
    case "gt":
      return ">";
    case "gte":
      return ">=";
    case "lt":
      return "<";
    case "lte":
      return "<=";
    case "contains":
      return ":";
    case "in":
      return same.includes("contains") ? "=" : ":";
    default:
      return same.includes("contains") || same.includes("in") ? "=" : ":";
  }
}

/** Whether the field's text is entered as listed values — an enumeration or yes and no. */
export function listedValues(field: TokenField): { value: string; label: string }[] | undefined {
  if (field.operator !== "eq" && field.operator !== "in") return undefined;
  const listed: unknown[] | undefined = Array.isArray(field.schema.enum) ? field.schema.enum : plainTypes(field.schema).includes("boolean") ? [true, false] : undefined;
  if (!listed) return undefined;
  return listed.map((value) => {
    const labelled = field.labels.find((entry) => JSON.stringify(entry.value) === JSON.stringify(value));
    return { value: String(value), label: labelled?.label ?? String(value) };
  });
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One typed value as its filter holds it, or why it cannot. */
export function readValue(field: TokenField, raw: string): { value: string } | { reason: "value-not-listed" | "value-invalid" } {
  const listed = listedValues(field);
  if (listed) {
    const lower = raw.toLowerCase();
    const found = listed.find((entry) => entry.value.toLowerCase() === lower || entry.label.toLowerCase() === lower);
    return found ? { value: found.value } : { reason: "value-not-listed" };
  }
  const types = plainTypes(field.schema);
  if (types.includes("integer") || types.includes("number")) {
    const number = Number(raw);
    const fits = Number.isFinite(number) && (!types.includes("integer") || types.includes("number") || Number.isInteger(number));
    return fits ? { value: raw } : { reason: "value-invalid" };
  }
  if (field.schema.format === "date") {
    return DATE.test(raw) && !Number.isNaN(Date.parse(raw)) && new Date(raw).toISOString().startsWith(raw) ? { value: raw } : { reason: "value-invalid" };
  }
  return { value: raw };
}

/** A token's property and spelling, and the text after them; nothing for text that names no property. */
export function tokenParts(text: string): { name: string; spelling: string; rest: string } | undefined {
  const typed = text.trimStart();
  const match = TOKEN.exec(typed);
  return match ? { name: match[1], spelling: match[2], rest: typed.slice(match[0].length).trim() } : undefined;
}

/**
 * What typed text means over a bar's filters. Reading depends on the text and
 * the filters alone: `:` picks a property's `contains`, else its `in`, else its
 * `eq`; `=` its `in`, else its `eq`; `>`, `>=`, `<` and `<=` the order filters.
 * Under `in` commas separate values; under any other operator the whole text is
 * one value.
 */
export function readToken(text: string, fields: TokenField[]): TokenReading {
  const parts = tokenParts(text);
  if (!parts) return { kind: "text" };
  const { name, spelling, rest } = parts;
  const picked = pick(fields, name, spelling);
  if (!picked.named) return { kind: "invalid", reason: "unknown-property" };
  if (picked.field === undefined) return { kind: "invalid", reason: "operator-unsupported" };
  const index = picked.field;
  const field = fields[index];
  if (field.relation && (field.operator === "eq" || field.operator === "in")) return { kind: "query", field: index, query: rest };
  const raws = field.operator === "in" ? separated(rest) : rest === "" ? [] : [rest];
  if (raws.length === 0) return { kind: "open", field: index };
  const values: string[] = [];
  for (const raw of raws) {
    const read = readValue(field, raw);
    if ("reason" in read) return { kind: "invalid", reason: read.reason, field: index };
    if (!values.includes(read.value)) values.push(read.value);
  }
  return { kind: "token", field: index, values };
}

/** A bar's values with a token committed: its filter holds the token's values and nothing it held before. */
export const commitToken = (held: Values, field: Pick<TokenField, "property" | "operator">, values: string[]): Values => ({
  ...held,
  [filterKey(field)]: values,
});
