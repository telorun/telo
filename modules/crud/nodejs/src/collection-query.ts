import { integerInput, InvokeError } from "@telorun/sdk";
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

/** One refused parameter: the name it was sent under, and why. */
export interface QueryDetail {
  path: string;
  message: string;
}

export function sortText(sort: Sort): string {
  return `${sort.descending ? "-" : ""}${sort.property.name}`;
}

const parameterOf = (property: string, operator?: string) => (operator === undefined ? property : `${property}.${operator}`);

const typeText = (property: ModelProperty) => property.types.join(" or ");

const NOT_ACCEPTED = "is not a filter this collection accepts";

function readFilter(
  properties: Map<string, ModelProperty>,
  accepted: AcceptedQuery,
  input: { property: string; operator?: string; value: unknown },
): Filter | string {
  const property = properties.get(input.property);
  // A spelled `eq` is no parameter: equality is the bare property name.
  if (!property || (input.operator !== undefined && !(OPERATORS as readonly string[]).includes(input.operator))) {
    return NOT_ACCEPTED;
  }
  const operator = (input.operator ?? "eq") as Operator;
  if (!accepted.filters.some((filter) => filter.property === property.name && filter.operator === operator)) {
    return NOT_ACCEPTED;
  }
  const comparison = (COMPARISONS as readonly string[]).includes(operator);
  const applies = operator === "contains" ? isText(property) : comparison ? isOrdered(property) : isScalar(property);
  if (!applies) return NOT_ACCEPTED;
  const given = Array.isArray(input.value) ? input.value : [input.value];
  if (given.length === 0) return "needs a value";
  if (operator !== "in" && given.length > 1) return `takes one value, and ${given.length} were sent`;
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
      return operator === "contains" ? "must be text" : `is not a value of type ${typeText(property)}`;
    }
    values.push(value);
  }
  return { property, operator, values };
}

/**
 * Judge a request against what the collection accepts, with value types from
 * the model. Everything wrong with it is reported at once, each under the
 * parameter that carried it.
 */
export function planQuery(
  properties: Map<string, ModelProperty>,
  accepted: AcceptedQuery,
  inputs: QueryInputs,
): CollectionQuery {
  const details: QueryDetail[] = [];

  const filters: Filter[] = [];
  for (const input of inputs.filters ?? []) {
    const filter = readFilter(properties, accepted, input);
    if (typeof filter === "string") details.push({ path: parameterOf(input.property, input.operator), message: filter });
    else filters.push(filter);
  }

  const key = properties.get(KEY)!;
  let sort: Sort = { property: key, descending: false };
  const keys = inputs.sort ?? [];
  if (keys.length > 1) {
    details.push({ path: "sort", message: "takes one property; `id` is always the tiebreaker" });
  } else if (keys.length === 1) {
    const property = properties.get(keys[0].property);
    const listed = accepted.sort.some((entry) => entry.property === keys[0].property);
    if (!property || !listed || !isScalar(property)) {
      details.push({ path: "sort", message: "is not a property this collection sorts by" });
    } else sort = { property, descending: keys[0].direction === "desc" };
  }

  const limit = inputs.limit === undefined || inputs.limit === null ? DEFAULT_LIMIT : integerInput(inputs.limit);
  if (limit === undefined || limit < 1 || limit > MAX_LIMIT) {
    details.push({ path: "limit", message: `must be an integer from 1 to ${MAX_LIMIT}` });
  }

  let after: CollectionQuery["after"];
  if (inputs.cursor !== undefined && inputs.cursor !== null) {
    const cursor = typeof inputs.cursor === "string" ? decodeCursor(inputs.cursor) : undefined;
    const value = cursor && cursor.value !== null ? readValue(sort.property, cursor.value) : null;
    const id = cursor ? readValue(key, cursor.id) : undefined;
    if (!cursor || value === undefined || id === undefined) {
      details.push({ path: "cursor", message: "is not a cursor this collection issued" });
    } else if (cursor.sort !== sortText(sort)) {
      details.push({ path: "cursor", message: "was issued for a different sort; start again without it" });
    } else {
      after = { value, id };
    }
  }

  if (details.length > 0) {
    throw new InvokeError(
      ERR_CRUD_QUERY_INVALID,
      `The query was refused: ${details.map((detail) => `'${detail.path}' ${detail.message}`).join("; ")}.`,
      { details },
    );
  }
  return { filters, sort, limit: limit as number, ...(after ? { after } : {}) };
}
