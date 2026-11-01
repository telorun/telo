import type { ReadPlan } from "./read-plan.js";

/**
 * The requests a listing's read plan sends — the reference
 * `conformance/listing-reads.json` holds a renderer to. A collection request is
 * its parameters in the order sent: `limit`, `cursor`, `sort` or `facet`, the
 * listing's filters, the bar's, then what the plan adds — the group's value,
 * the period's bounds, the tree level.
 */

/** One query parameter. */
export type Param = [name: string, value: string];

export interface CollectionRequest {
  path: string;
  params: Param[];
}

/** What every read of one listing carries. */
export interface ListingReads {
  basePath: string;
  pageSize: number;
  /** The listing's own filters, as the values they are sent with. */
  filters: Param[];
  /** The filter bar's filters, in the bar's order. */
  bar: Param[];
  /** The viewer's sort: one property, `-` before it for descending. */
  sort?: string;
}

/** Which read of the plan's product: a group's value, a shown period, a tree
 *  level — the roots when `parent` is absent. */
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

/** One page of the read at `at`: the first, or the one `cursor` names. */
export function pageRequest(listing: ListingReads, plan: ReadPlan, at: ReadPosition, cursor?: string): CollectionRequest {
  return {
    path: listing.basePath,
    params: [
      ["limit", String(listing.pageSize)],
      ...(cursor !== undefined ? [["cursor", cursor] as Param] : []),
      ...(listing.sort !== undefined ? [["sort", listing.sort] as Param] : []),
      ...listing.filters,
      ...listing.bar,
      ...planParams(plan, at),
    ],
  };
}

/**
 * The requests reloading a read that has `loaded` pages, in order: each from
 * the first, its cursor the `next` the previous one answered (`answers`), since
 * a cursor is opaque — ending early when an answer has no next. With more than
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

/** Where a grouping's values are paged from when the plan pages them from a
 *  relation: its source's `basePath` and `pageSize`. */
export interface RelatedSource {
  basePath: string;
  pageSize: number;
}

/**
 * The request reading one page of a grouping's values: under `present` the
 * facet request, carrying the listing's and the bar's filters and no sort;
 * under `all` over a relation, a page of the related records. Nothing when
 * the plan lists its values.
 */
export function valuesRequest(
  listing: ListingReads,
  plan: ReadPlan,
  relations: Readonly<Record<string, RelatedSource>>,
  cursor?: string,
): CollectionRequest | undefined {
  const groups = plan.groups;
  if (!groups) throw new Error("a plan with no grouping has no values to read");
  const page = (pageSize: number): Param[] => [["limit", String(pageSize)], ...(cursor !== undefined ? [["cursor", cursor] as Param] : [])];
  if (groups.values === "present") {
    return { path: listing.basePath, params: [...page(listing.pageSize), ["facet", groups.property], ...listing.filters, ...listing.bar] };
  }
  if (groups.enum) return undefined;
  const related = groups.relation === undefined ? undefined : relations[groups.relation];
  if (!related) throw new Error(`the values of '${groups.property}' are listed by no enum and paged from no relation`);
  return { path: related.basePath, params: page(related.pageSize) };
}
