import type { CollectionRequest, Param } from "./collection.js";
import type { ValueLabel } from "./texts.js";

/**
 * The requests a listing's read plan sends, as `ui`'s
 * `conformance/listing-reads.json` pins them. A collection request's
 * parameters come in one order: `limit`, `cursor`, `sort` or `facet`, the
 * listing's filters, the bar's, then what the plan adds — the group's value,
 * the period's bounds, the tree level.
 */

/** `reads.groups` as the page document carries it. */
export interface GroupsPlan {
  property: string;
  values: "all" | "present";
  enum?: (string | number | boolean)[];
  relation?: string;
  labels: ValueLabel[];
}

/** A layout's read plan: three dimensions composing as a product. */
export interface ReadPlan {
  groups?: GroupsPlan;
  span?: { start: string; end?: string; format: "date" | "date-time" };
  parent?: string;
}

/** What every read of one listing carries. */
export interface ListingReads {
  basePath: string;
  pageSize: number;
  /** The listing's own filters, as sent. */
  filters: Param[];
  /** The filter bars' filters, outermost first, each bar in its own order. */
  bar: Param[];
  /** The viewer's sort: one property, `-` before it for descending. */
  sort?: string;
}

/** Which read of the product: a group's value, a shown period, a tree level —
 *  the roots when `parent` is absent. Values are as sent. */
export interface ReadPosition {
  group?: string;
  period?: { from: string; to: string };
  parent?: string;
}

/** With more loaded than this in one read, a reload refetches its first page only. */
export const RELOAD_PAGE_LIMIT = 10;

/** What the plan adds to a read at `at`, dimension by dimension. */
function planParams(plan: ReadPlan, at: ReadPosition): Param[] {
  const params: Param[] = [];
  if (plan.groups) {
    if (at.group === undefined) throw new Error(`a read of a plan grouped by '${plan.groups.property}' names no group`);
    params.push([plan.groups.property, at.group]);
  }
  if (plan.span) {
    if (!at.period) throw new Error(`a read of a plan spanned by '${plan.span.start}' names no period`);
    const { start, end } = plan.span;
    if (end === undefined) params.push([`${start}.gte`, at.period.from], [`${start}.lte`, at.period.to]);
    else params.push([`${start}.lte`, at.period.to], [`${end}.gte`, at.period.from]);
  }
  if (plan.parent !== undefined) {
    params.push(at.parent === undefined ? [`${plan.parent}.absent`, "true"] : [plan.parent, at.parent]);
  }
  return params;
}

const paged = (limit: number, cursor: string | undefined): Param[] => [
  ["limit", String(limit)],
  ...(cursor !== undefined ? [["cursor", cursor] as Param] : []),
];

/** One page of the read at `at`: the first, or the one `cursor` names. */
export function pageRequest(listing: ListingReads, plan: ReadPlan, at: ReadPosition, cursor?: string): CollectionRequest {
  return {
    path: listing.basePath,
    params: [
      ...paged(listing.pageSize, cursor),
      ...(listing.sort !== undefined ? [["sort", listing.sort] as Param] : []),
      ...listing.filters,
      ...listing.bar,
      ...planParams(plan, at),
    ],
  };
}

/**
 * The requests reloading a read that has `loaded` pages, in order: each from
 * the first, its cursor the `next` the refetch before it answered (`answers`),
 * since a cursor is opaque — ending at an answer with no next. With more than
 * {@link RELOAD_PAGE_LIMIT} loaded, the first page alone.
 */
export function reloadRequests(
  listing: ListingReads,
  plan: ReadPlan,
  at: ReadPosition,
  loaded: number,
  answers: readonly (string | null)[],
): CollectionRequest[] {
  if (loaded > RELOAD_PAGE_LIMIT) return [pageRequest(listing, plan, at)];
  const requests = [pageRequest(listing, plan, at)];
  for (let page = 1; page < loaded; page++) {
    const next = answers[page - 1];
    if (next == null) break;
    requests.push(pageRequest(listing, plan, at, next));
  }
  return requests;
}

/** Where a grouping's values are paged from when they are related records. */
export interface RelatedSource {
  basePath: string;
  pageSize: number;
}

/** The facet request: one page of a property's present values under the filters given, no sort. */
export function facetRequest(basePath: string, limit: number, property: string, filters: Param[], cursor?: string): CollectionRequest {
  return { path: basePath, params: [...paged(limit, cursor), ["facet", property], ...filters] };
}

/**
 * The request reading one page of a grouping's values: under `present` the
 * facet request, carrying the listing's and the bars' filters; under `all`
 * over a relation, a page of the related records. Nothing when the plan lists
 * its values.
 */
export function valuesRequest(
  listing: ListingReads,
  plan: ReadPlan,
  relations: Readonly<Record<string, RelatedSource>>,
  cursor?: string,
): CollectionRequest | undefined {
  const groups = plan.groups;
  if (!groups) throw new Error("a plan with no grouping has no values to read");
  if (groups.values === "present") {
    return facetRequest(listing.basePath, listing.pageSize, groups.property, [...listing.filters, ...listing.bar], cursor);
  }
  if (groups.enum) return undefined;
  const related = groups.relation === undefined ? undefined : relations[groups.relation];
  if (!related) throw new Error(`the values of '${groups.property}' are listed by no enum and paged from no relation`);
  return { path: related.basePath, params: paged(related.pageSize, cursor) };
}

/** A read's identity among a listing's reads. */
export const positionKey = (at: ReadPosition): string => JSON.stringify([at.group ?? null, at.period ?? null, at.parent ?? null]);
