import { integerInput, InvokeError, jsonPointerSegment, valueIssue, type ValueIssue } from "@telorun/sdk";
import {
  isOrdered,
  isScalar,
  isText,
  readOrderedValue,
  readValue,
  type ModelProperty,
} from "./model-properties.js";
import { KEY } from "./model-properties.js";
import { decodeCursor } from "./page-cursor.js";

export const ERR_CRUD_QUERY_INVALID = "ERR_CRUD_QUERY_INVALID";

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

const COMPARISONS = ["gt", "gte", "lt", "lte"] as const;
const OPERATORS = ["contains", ...COMPARISONS, "in"] as const;
/** `eq` is the absence of an operator; no request spells it. */
export type Operator = (typeof OPERATORS)[number] | "eq";

/** What a collection declares its list request may filter and sort by. */
export interface AcceptedQuery {
  filters: { property: string; operator: string }[];
  sort: { property: string }[];
}

/** What a caller asks for, before anything in it has been judged. */
export interface QueryInputs {
  filters?: { property: string; operator?: string; value: unknown }[];
  sort?: { property: string; direction?: string }[];
  limit?: unknown;
  cursor?: unknown;
}

export interface Filter {
  property: ModelProperty;
  operator: Operator;
  /** One value; several for `in`. */
  values: unknown[];
}

export interface Sort {
  property: ModelProperty;
  descending: boolean;
}

/** A request every part of which is a declared filter or sort with a typed value. */
export interface CollectionQuery {
  filters: Filter[];
  sort: Sort;
  limit: number;
  /** The row the page starts after. */
  after?: { value: unknown; id: unknown };
}

export function sortText(sort: Sort): string {
  return `${sort.descending ? "-" : ""}${sort.property.name}`;
}

const parameterOf = (property: string, operator?: string) => (operator === undefined ? property : `${property}.${operator}`);

/** A finding about one parameter, its pointer naming the parameter. */
const issueAt = (parameter: string, keyword: string, params?: Record<string, unknown>): ValueIssue =>
  valueIssue(`/${jsonPointerSegment(parameter)}`, keyword, params);

function readFilter(
  properties: Map<string, ModelProperty>,
  accepted: AcceptedQuery,
  input: { property: string; operator?: string; value: unknown },
): Filter | ValueIssue {
  const parameter = parameterOf(input.property, input.operator);
  const notAccepted = () => issueAt(parameter, "additionalProperties", { additionalProperty: parameter });
  const property = properties.get(input.property);
  // A spelled `eq` is no parameter: equality is the bare property name.
  if (!property || (input.operator !== undefined && !(OPERATORS as readonly string[]).includes(input.operator))) {
    return notAccepted();
  }
  const operator = (input.operator ?? "eq") as Operator;
  if (!accepted.filters.some((filter) => filter.property === property.name && filter.operator === operator)) {
    return notAccepted();
  }
  const comparison = (COMPARISONS as readonly string[]).includes(operator);
  const applies = operator === "contains" ? isText(property) : comparison ? isOrdered(property) : isScalar(property);
  if (!applies) return notAccepted();
  const given = Array.isArray(input.value) ? input.value : [input.value];
  if (given.length === 0) return issueAt(parameter, "minItems", { limit: 1 });
  if (operator !== "in" && given.length > 1) return issueAt(parameter, "maxItems", { limit: 1 });
  const values: unknown[] = [];
  for (const raw of given) {
    const value =
      operator === "contains"
        ? typeof raw === "string"
          ? raw
          : undefined
        : comparison
          ? readOrderedValue(property, raw)
          : readValue(property, raw);
    if (value === undefined) {
      return issueAt(parameter, "type", { type: operator === "contains" ? "string" : property.types.join(",") });
    }
    values.push(value);
  }
  return { property, operator, values };
}

/**
 * Judge a request against what the collection accepts, with value types from
 * the model. Everything wrong with it is reported at once, one issue per
 * parameter that carried it, its pointer naming the parameter.
 */
export function planQuery(
  properties: Map<string, ModelProperty>,
  accepted: AcceptedQuery,
  inputs: QueryInputs,
): CollectionQuery {
  const issues: ValueIssue[] = [];

  const filters: Filter[] = [];
  for (const input of inputs.filters ?? []) {
    const filter = readFilter(properties, accepted, input);
    if ("pointer" in filter) issues.push(filter);
    else filters.push(filter);
  }

  const key = properties.get(KEY)!;
  let sort: Sort = { property: key, descending: false };
  const keys = inputs.sort ?? [];
  if (keys.length > 1) {
    issues.push(issueAt("sort", "maxItems", { limit: 1 }));
  } else if (keys.length === 1) {
    const property = properties.get(keys[0].property);
    const listed = accepted.sort.some((entry) => entry.property === keys[0].property);
    if (!property || !listed || !isScalar(property)) {
      const allowedValues = sortable(properties, accepted);
      issues.push(allowedValues.length > 0 ? issueAt("sort", "enum", { allowedValues }) : issueAt("sort", "invalid"));
    } else sort = { property, descending: keys[0].direction === "desc" };
  }

  const limit = inputs.limit === undefined || inputs.limit === null ? DEFAULT_LIMIT : integerInput(inputs.limit);
  if (limit === undefined || limit < 1 || limit > MAX_LIMIT) {
    issues.push(
      limit === undefined
        ? issueAt("limit", "type", { type: "integer" })
        : limit < 1
          ? issueAt("limit", "minimum", { comparison: ">=", limit: 1 })
          : issueAt("limit", "maximum", { comparison: "<=", limit: MAX_LIMIT }),
    );
  }

  let after: CollectionQuery["after"];
  if (inputs.cursor !== undefined && inputs.cursor !== null) {
    const cursor = typeof inputs.cursor === "string" ? decodeCursor(inputs.cursor) : undefined;
    const value = cursor && cursor.value !== null ? readValue(sort.property, cursor.value) : null;
    const id = cursor ? readValue(key, cursor.id) : undefined;
    if (!cursor || value === undefined || id === undefined) {
      issues.push(issueAt("cursor", "invalid"));
    } else if (cursor.sort !== sortText(sort)) {
      issues.push(issueAt("cursor", "invalid"));
    } else {
      after = { value, id };
    }
  }

  if (issues.length > 0) {
    throw new InvokeError(
      ERR_CRUD_QUERY_INVALID,
      `The query was refused: ${issues.map((issue) => `'${issue.pointer}' (${issue.keyword})`).join("; ")}.`,
      { issues },
    );
  }
  return { filters, sort, limit: limit as number, ...(after ? { after } : {}) };
}

/** What a sort may name, each property in both directions. */
function sortable(properties: Map<string, ModelProperty>, accepted: AcceptedQuery): string[] {
  const names = accepted.sort.map((entry) => entry.property).filter((name) => {
    const property = properties.get(name);
    return property !== undefined && isScalar(property);
  });
  return names.flatMap((name) => [name, `-${name}`]);
}
