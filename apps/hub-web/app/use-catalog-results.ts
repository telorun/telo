import * as React from "react";

import {
  requestedType,
  searchModules,
  type HiddenMatches,
  type ModuleHit,
  type SearchRequest,
} from "@/api";

/** What the hub has answered for one request so far: the rows loaded, how many
 *  are listed, how many matches it left out, and whether it dropped the category
 *  because nothing matched in it. */
export interface CatalogPage {
  hits: ModuleHit[];
  total: number;
  hidden: HiddenMatches;
  categoryDropped: boolean;
}

export interface CatalogResults {
  /** The rows to show. While a new request is in flight these are the previous
   *  request's, so the list dims instead of emptying on every keystroke. */
  page: CatalogPage | null;
  /** The shown rows answer an older request than the current one. */
  stale: boolean;
  error: string | null;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
}

/** Pages already loaded this visit, by request. Going back to a search — or
 *  returning from a module page — shows it at once, at the length it had been
 *  paged to, which is also what lets the browser restore the scroll position.
 *  Written only from effects, so it never exists on the server. */
const loaded = new Map<string, CatalogPage>();

function requestKey(request: SearchRequest): string {
  return JSON.stringify([
    request.query,
    request.category,
    request.publisher,
    request.sort,
    request.runtime,
    requestedType(request),
    request.showDeprecated,
    request.hideContractOnly,
  ]);
}

/**
 * The catalogue rows for a request, paged.
 *
 * `seed` is the first page the server already read for this route's category
 * and publisher with no query and no other filter — deprecated modules left
 * out, as a listing leaves them by default; it answers exactly that request —
 * libraries and applications alike — and no other.
 */
export function useCatalogResults(
  origin: string,
  request: SearchRequest,
  seed: { category: string; publisher: string; page: CatalogPage } | null,
): CatalogResults {
  const key = requestKey(request);
  const seedKey = seed
    ? requestKey({
        query: "",
        category: seed.category,
        publisher: seed.publisher,
        sort: "relevance",
        runtime: "",
        type: "all",
        showDeprecated: false,
        hideContractOnly: false,
        offset: 0,
      })
    : null;
  const seeded = seedKey === key ? seed!.page : null;

  const [state, setState] = React.useState<{
    key: string | null;
    page: CatalogPage | null;
    error: string | null;
  }>(() => ({ key: seeded ? key : null, page: seeded, error: null }));
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const known = loaded.get(key) ?? seeded;
    if (known) {
      setState({ key, page: known, error: null });
      return;
    }
    const controller = new AbortController();
    searchModules(origin, { ...request, offset: 0 }, controller.signal)
      .then((result) => {
        if (!result.ok) {
          setState({ key, page: null, error: result.error });
          return;
        }
        const page = {
          hits: result.hits,
          total: result.total,
          hidden: result.hidden,
          categoryDropped: result.categoryFilterDropped,
        };
        loaded.set(key, page);
        setState({ key, page, error: null });
      })
      .catch(() => {
        // Aborted by a newer request — that run owns the state.
      });
    return () => controller.abort();
    // `request` is fully described by `key`; `seeded` only matters on the first run.
  }, [origin, key, attempt]);

  const current = state.key === key ? state.page : null;

  const loadMore = () => {
    if (!current || loadingMore) return;
    setLoadingMore(true);
    searchModules(origin, { ...request, offset: current.hits.length })
      .then((result) => {
        if (!result.ok) {
          setState((s) => (s.key === key ? { key, page: current, error: result.error } : s));
          return;
        }
        const page = {
          ...current,
          hits: [...current.hits, ...result.hits],
          total: result.total,
          hidden: result.hidden,
        };
        loaded.set(key, page);
        setState((s) => (s.key === key ? { key, page, error: null } : s));
      })
      .finally(() => setLoadingMore(false));
  };

  return {
    page: state.page,
    stale: state.key !== key,
    error: state.key === key ? state.error : null,
    loadingMore,
    loadMore,
    retry: () => setAttempt((n) => n + 1),
  };
}
