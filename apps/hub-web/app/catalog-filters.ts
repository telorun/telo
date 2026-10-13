import type { ModuleType, RuntimeFilter, SearchRequest, SortOrder } from "@/api";

/** Everything that narrows and orders the catalogue, apart from the category.
 *  One reader and one writer (`catalogPath`), so a link built anywhere reads
 *  back as the same filters. */
export interface CatalogFilters {
  query: string;
  /** A publisher as `module.publisher` reports it (`ghcr.io/telorun`). */
  publisher: string;
  sort: SortOrder;
  runtime: RuntimeFilter;
  /** Libraries, applications, or both. */
  type: ModuleType;
  /** Deprecated modules are left out unless asked for: a reader choosing what
   *  to build on should not have to know to filter them away. */
  showDeprecated: boolean;
  hideContractOnly: boolean;
}

const RUNTIMES: readonly RuntimeFilter[] = ["nodejs", "rust"];
const SORTS: readonly SortOrder[] = ["name", "recent"];
const TYPES: readonly ModuleType[] = ["library", "application"];

/** The filters a URL carries. `pathPublisher` is the publisher a
 *  `/publisher/…` path names; elsewhere it travels as `?publisher=`. */
export function readFilters(params: URLSearchParams, pathPublisher = ""): CatalogFilters {
  const hidden = params.getAll("hide");
  const type = TYPES.find((t) => t === params.get("type")) ?? "all";
  const query = params.get("q") ?? "";
  return {
    query,
    publisher: pathPublisher || (params.get("publisher") ?? ""),
    // An order other than relevance is for browsing: with a query the hub
    // would be ordering only its ranked candidates.
    sort: query ? "relevance" : (SORTS.find((s) => s === params.get("sort")) ?? "relevance"),
    // The hub refuses a runtime beside applications, so the pair never exists.
    runtime: type === "application" ? "" : (RUNTIMES.find((r) => r === params.get("runtime")) ?? ""),
    type,
    showDeprecated: params.getAll("show").includes("deprecated"),
    hideContractOnly: hidden.includes("contract"),
  };
}

function filterParams(filters: CatalogFilters, publisherInPath: boolean): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.query) params.set("q", filters.query);
  if (filters.publisher && !publisherInPath) params.set("publisher", filters.publisher);
  if (filters.sort !== "relevance" && !filters.query) params.set("sort", filters.sort);
  if (filters.type !== "all") params.set("type", filters.type);
  if (filters.runtime && filters.type !== "application") params.set("runtime", filters.runtime);
  if (filters.showDeprecated) params.set("show", "deprecated");
  if (filters.hideContractOnly) params.set("hide", "contract");
  return params;
}

export const NO_FILTERS: CatalogFilters = {
  query: "",
  publisher: "",
  sort: "relevance",
  runtime: "",
  type: "all",
  showDeprecated: false,
  hideContractOnly: false,
};

/** A publisher's own page: `/publisher/ghcr.io/telorun`. */
export function publisherPath(publisher: string): string {
  return `/publisher/${publisher.split("/").map(encodeURIComponent).join("/")}`;
}

/** Where a category (empty for all of them) is browsed under some filters.
 *
 *  Each view has one address. A category is the path (`/category/<slug>`); a
 *  publisher is the path when no category is (`/publisher/<host>/<org>`) and a
 *  `?publisher=` beside a category; everything else is the query string. */
export function catalogPath(category: string, filters: CatalogFilters = NO_FILTERS): string {
  const publisherInPath = !category && Boolean(filters.publisher);
  const path = category
    ? `/category/${encodeURIComponent(category)}`
    : publisherInPath
      ? publisherPath(filters.publisher)
      : "/";
  const query = filterParams(filters, publisherInPath).toString();
  return query ? `${path}?${query}` : path;
}

/** The hub request a category and its filters stand for. */
export function searchRequest(category: string, filters: CatalogFilters, offset = 0): SearchRequest {
  return {
    query: filters.query,
    category,
    publisher: filters.publisher,
    sort: filters.sort,
    runtime: filters.runtime,
    type: filters.type,
    showDeprecated: filters.showDeprecated,
    hideContractOnly: filters.hideContractOnly,
    offset,
  };
}

/** Whether the hub is being asked for anything beyond "list everything". */
export function isNarrowed(category: string, filters: CatalogFilters): boolean {
  return Boolean(
    category ||
      filters.query ||
      filters.publisher ||
      filters.sort !== "relevance" ||
      filters.runtime ||
      filters.type !== "all",
  );
}
