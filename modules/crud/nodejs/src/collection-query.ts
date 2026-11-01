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
import { decodeCursor, decodeFacetCursor } from "./page-cursor.js";

export const ERR_CRUD_QUERY_INVALID = "ERR_CRUD_QUERY_INVALID";

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

const COMPARISONS = ["gt", "gte", "lt", "lte"] as const;
const OPERATORS = ["contains", ...COMPARISONS, "in", "absent"] as const;
/** `eq` is the absence of an operator; no request spells it. */
export type Operator = (typeof OPERATORS)[number] | "eq";

/** What a collection declares its list request may filter, sort and facet by. */
export interface AcceptedQuery {
  filters: { property: string; operator: string }[];
  sort: { property: string }[];
  /** Absent: no property is faceted. */
  facets?: { property: string }[];
}

/** What a caller asks for, before anything in it has been judged. */
export interface QueryInputs {
  filters?: { property: string; operator?: string; value: unknown }[];
  sort?: { property: string; direction?: string }[];
  /** The property whose present values are asked for instead of rows. */
  facet?: unknown;
  limit?: unknown;
  cursor?: unknown;
}

export interface Filter {
  property: ModelProperty;
  operator: Operator;
  /** One value; several for `in`; for `absent`, whether the property is absent. */
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

/** A request for one property's present values, with counts, under the filters. */
export interface FacetQuery {
  filters: Filter[];
  property: ModelProperty;
  limit: number;
  /** The value the page starts after. */
  after?: { value: unknown };
}

/** Whether a property's declared type carries an operator. */
function operatorApplies(property: ModelProperty, operator: Operator): boolean {
  if (operator === "contains") return isText(property);
  if ((COMPARISONS as readonly string[]).includes(operator)) return isOrdered(property);
  // A record can lack the property only where the model lets it.
  if (operator === "absent") return !property.required || property.nullable;
  return isScalar(property);
}

export function sortText(sort: Sort): string {
  return `${sort.descending ? "-" : ""}${sort.property.name}`;
}

const parameterOf = (property: string, operator?: string) => (operator === undefined ? property : `${property}.${operator}`);

/** A finding about one parameter, its pointer naming the parameter. */
const issueAt = (parameter: string, keyword: string, params?: Record<string, unknown>): ValueIssue =>
  valueIssue(`/${jsonPointerSegment(parameter)}`, keyword, params);

/** How an `absent` filter's value is read: `true` or `false`. */
const PRESENCE: ModelProperty = { name: "", column: "", types: ["boolean"], nullable: false, required: true };

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
  if (!operatorApplies(property, operator)) return notAccepted();
  const comparison = (COMPARISONS as readonly string[]).includes(operator);
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
        : operator === "absent"
          ? readValue(PRESENCE, raw)
          : comparison
            ? readOrderedValue(property, raw)
            : readValue(property, raw);
    if (value === undefined) {
      const type = operator === "contains" ? "string" : operator === "absent" ? "boolean" : property.types.join(",");
      return issueAt(parameter, "type", { type });
    }
    values.push(value);
  }
  return { property, operator, values };
}

/** Every declared filter of a request, and an issue for each that is not one. */
function readFilters(properties: Map<string, ModelProperty>, accepted: AcceptedQuery, inputs: QueryInputs, issues: ValueIssue[]): Filter[] {
  const filters: Filter[] = [];
  for (const input of inputs.filters ?? []) {
    const filter = readFilter(properties, accepted, input);
    if ("pointer" in filter) issues.push(filter);
    else filters.push(filter);
  }
  return filters;
}

function readLimit(inputs: QueryInputs, issues: ValueIssue[]): number {
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
  return limit as number;
}

function refuseIfAny(issues: ValueIssue[]): void {
  if (issues.length > 0) {
    throw new InvokeError(
      ERR_CRUD_QUERY_INVALID,
      `The query was refused: ${issues.map((issue) => `'${issue.pointer}' (${issue.keyword})`).join("; ")}.`,
      { issues },
    );
  }
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
  const filters = readFilters(properties, accepted, inputs, issues);

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

  const limit = readLimit(inputs, issues);

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

  refuseIfAny(issues);
  return { filters, sort, limit, ...(after ? { after } : {}) };
}

/**
 * Judge a facet request: the property must be one the collection facets, and
 * the filters, limit and cursor are read as a list's. A facet's values are in
 * value order, so it takes no `sort`.
 */
export function planFacet(
  properties: Map<string, ModelProperty>,
  accepted: AcceptedQuery,
  inputs: QueryInputs,
): FacetQuery {
  const issues: ValueIssue[] = [];
  const filters = readFilters(properties, accepted, inputs, issues);

  const named = typeof inputs.facet === "string" ? inputs.facet : undefined;
  const faceted = facetable(properties, accepted);
  const property = named !== undefined && faceted.includes(named) ? properties.get(named) : undefined;
  if (!property) {
    issues.push(
      named === undefined
        ? issueAt("facet", "type", { type: "string" })
        : faceted.length > 0
          ? issueAt("facet", "enum", { allowedValues: faceted })
          : issueAt("facet", "invalid"),
    );
  }
  if ((inputs.sort ?? []).length > 0) issues.push(issueAt("sort", "additionalProperties", { additionalProperty: "sort" }));

  const limit = readLimit(inputs, issues);

  let after: FacetQuery["after"];
  if (inputs.cursor !== undefined && inputs.cursor !== null) {
    const cursor = typeof inputs.cursor === "string" ? decodeFacetCursor(inputs.cursor) : undefined;
    const value = cursor && property && cursor.property === property.name ? readValue(property, cursor.value) : undefined;
    if (value === undefined) issues.push(issueAt("cursor", "invalid"));
    else after = { value };
  }

  refuseIfAny(issues);
  return { filters, property: property!, limit, ...(after ? { after } : {}) };
}

/** What a facet request may name. */
function facetable(properties: Map<string, ModelProperty>, accepted: AcceptedQuery): string[] {
  return (accepted.facets ?? []).map((entry) => entry.property).filter((name) => {
    const property = properties.get(name);
    return property !== undefined && isScalar(property);
  });
}

/** What a sort may name, each property in both directions. */
function sortable(properties: Map<string, ModelProperty>, accepted: AcceptedQuery): string[] {
  const names = accepted.sort.map((entry) => entry.property).filter((name) => {
    const property = properties.get(name);
    return property !== undefined && isScalar(property);
  });
  return names.flatMap((name) => [name, `-${name}`]);
}
