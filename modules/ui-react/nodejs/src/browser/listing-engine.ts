import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchFacet, fetchRequest, type CollectionPage, type CollectionRequest } from "./collection.js";
import type { Host } from "./host.js";
import { pageRequest, positionKey, RELOAD_PAGE_LIMIT, valuesRequest, type ListingReads, type ReadPlan, type ReadPosition, type RelatedSource } from "./listing-reads.js";
import { optionOf, type ChoiceOption, type OptionSourceSpec } from "./option-source.js";
import { errorSpec, type ErrorSpec } from "./ui-error.js";

type Row = Record<string, unknown>;

/**
 * How one read reaches its further pages: `pages` shows one page at a time
 * behind a pager that keeps the cursors read, `more` appends each next page
 * when asked, `all` reads every page as soon as the one before it answers.
 */
export type ReadMode = "pages" | "more" | "all";

/** The way each layout reads: a table, a list and cards follow the listing's
 *  `paging`; a board and a tree always load more; a calendar and a timeline
 *  read all of a period's pages. A component reads as its plan says: a span
 *  all of a period's pages, a grouping or a tree more, pages alone as paged. */
export function readMode(layout: string, plan: ReadPlan, paging: "pages" | "more" | "scroll"): ReadMode {
  if (layout === "calendar" || layout === "timeline" || plan.span) return "all";
  if (layout === "board" || layout === "tree" || plan.groups || plan.parent !== undefined) return "more";
  return paging === "pages" ? "pages" : "more";
}

interface ReadState {
  /** The pages drawn: every page loaded, or under `pages` the one shown. */
  pages: CollectionPage[];
  /** Under `pages`: the page shown, the cursor each page is read with and the
   *  number of its first record. */
  index: number;
  cursors: (string | undefined)[];
  starts: number[];
  loading: boolean;
  failure?: ErrorSpec;
}

/** A record as a layout draws it: its key, and the row as read. */
export interface ListedRecord {
  key: string;
  row: Row;
}

/** One read of the plan's product as a layout draws it. */
export interface ReadView {
  key: string;
  position: ReadPosition;
  /** Every record drawn, in order, each key once. */
  records: ListedRecord[];
  /** The records by the page they came in: what a long listing draws in view. */
  blocks: ListedRecord[][];
  /** Every record the read matches, from the collection's `total`. */
  total?: number;
  /** Whether a first page has answered. */
  answered: boolean;
  loading: boolean;
  failure?: ErrorSpec;
  /** Whether a further page exists. */
  hasMore: boolean;
  /** Read the next page and append it; nothing while one is in flight. */
  loadMore(): void;
  /** Under `pages`: the pager over the read. */
  pager?: { index: number; start: number; hasPrevious: boolean; hasNext: boolean; previous(): void; next(): void };
}

const EMPTY: CollectionPage = { rows: [], total: 0, next: null };

const blank = (): ReadState => ({ pages: [], index: 0, cursors: [undefined], starts: [0], loading: true });

interface ReadsInput {
  host: Host;
  prefix: string;
  /** What every read carries; absent while a fixed filter holds nothing, and nothing is read. */
  listing: ListingReads | undefined;
  plan: ReadPlan;
  mode: ReadMode;
  positions: readonly ReadPosition[];
  keyOf: (row: Row) => string;
  /** Hidden, nothing is read; on show, what changed meanwhile is read. */
  visible: boolean;
}

export interface Reads {
  reads: ReadView[];
  /** Read every loaded page again, under the reload rule. */
  reload(): void;
  /** Draw a record a write answered with in place of the one of its key, wherever it is drawn. */
  patch(row: Row): void;
}

/**
 * The read executor: one read per position of the plan's product, each paged
 * as its mode says. A change of what the reads carry — a filter, the sort —
 * returns every read to its first page. A reload keeps what is drawn until it
 * answers: it refetches the loaded pages in order from the first, each with the
 * cursor the refetch before it answered, and draws them together; with more
 * than {@link RELOAD_PAGE_LIMIT} pages loaded it refetches the first page alone,
 * in place, and leaves the rest as drawn. Records are matched by key, so a
 * record whose key remains keeps its element.
 */
export function useListingReads({ host, prefix, listing, plan, mode, positions, keyOf, visible }: ReadsInput): Reads {
  const query = JSON.stringify([listing ?? null, plan, mode]);
  const [held, setHeld] = useState<{ query: string; reads: ReadonlyMap<string, ReadState> }>({ query, reads: new Map() });
  const latest = useRef(held);
  latest.current = held;
  const generations = useRef(new Map<string, number>());
  const [changes, setChanges] = useState(0);
  const handled = useRef(0);
  const byKey = new Map(positions.map((position) => [positionKey(position), position]));
  const positionsKey = JSON.stringify([...byKey.keys()]);

  const write = (key: string, at: number, change: (state: ReadState) => ReadState) => {
    if ((generations.current.get(key) ?? 0) !== at) return;
    setHeld((current) => {
      if (current.query !== query) return current;
      const state = current.reads.get(key);
      if (!state) return current;
      const reads = new Map(current.reads);
      reads.set(key, change(state));
      const next = { query: current.query, reads };
      latest.current = next;
      return next;
    });
  };
  const begin = (key: string) => {
    const at = (generations.current.get(key) ?? 0) + 1;
    generations.current.set(key, at);
    return at;
  };
  const request = (position: ReadPosition, cursor?: string): CollectionRequest => pageRequest(listing!, plan, position, cursor);
  const failed = (key: string, at: number) => (error: unknown) =>
    write(key, at, (state) => ({ ...state, loading: false, failure: errorSpec(error, "ERR_UI_REQUEST_FAILED") }));

  /** Under `all`, read the pages after `page` and append each. */
  const readOn = (key: string, position: ReadPosition, at: number, page: CollectionPage) => {
    if (mode !== "all" || page.next === null) return write(key, at, (state) => ({ ...state, loading: false, failure: undefined }));
    fetchRequest(host, prefix, request(position, page.next)).then((next) => {
      write(key, at, (state) => ({ ...state, pages: [...state.pages, next] }));
      readOn(key, position, at, next);
    }, failed(key, at));
  };

  const open = (key: string, position: ReadPosition) => {
    const at = begin(key);
    if (!listing) {
      setHeld((current) => ({ ...current, reads: new Map(current.reads).set(key, { ...blank(), pages: [EMPTY], loading: false }) }));
      return;
    }
    setHeld((current) => ({ ...current, reads: new Map(current.reads).set(key, blank()) }));
    fetchRequest(host, prefix, request(position)).then((page) => {
      write(key, at, (state) => ({ ...state, pages: [page], cursors: [undefined, page.next ?? undefined], starts: [0, page.rows.length] }));
      readOn(key, position, at, page);
    }, failed(key, at));
  };

  const show = (key: string, position: ReadPosition, index: number) => {
    const state = latest.current.reads.get(key);
    if (!state || !listing) return;
    const at = begin(key);
    write(key, at, (current) => ({ ...current, index, loading: true }));
    fetchRequest(host, prefix, request(position, state.cursors[index])).then(
      (page) =>
        write(key, at, (current) => {
          const cursors = [...current.cursors];
          const starts = [...current.starts];
          cursors[index + 1] = page.next ?? undefined;
          starts[index + 1] = (starts[index] ?? 0) + page.rows.length;
          return { ...current, pages: [page], cursors, starts, loading: false, failure: undefined };
        }),
      failed(key, at),
    );
  };

  const more = (key: string, position: ReadPosition) => {
    const state = latest.current.reads.get(key);
    const last = state?.pages[state.pages.length - 1];
    if (!state || !listing || state.loading || !last || last.next === null) return;
    const at = generations.current.get(key) ?? 0;
    write(key, at, (current) => ({ ...current, loading: true }));
    fetchRequest(host, prefix, request(position, last.next)).then(
      (page) => write(key, at, (current) => ({ ...current, pages: [...current.pages, page], loading: false, failure: undefined })),
      failed(key, at),
    );
  };

  const reloadOne = (key: string, position: ReadPosition) => {
    const state = latest.current.reads.get(key);
    if (!state || !listing) return open(key, position);
    if (mode === "pages") return show(key, position, state.index);
    const loaded = state.pages.length;
    if (loaded === 0) return open(key, position);
    const at = begin(key);
    write(key, at, (current) => ({ ...current, loading: true }));
    if (loaded > RELOAD_PAGE_LIMIT) {
      fetchRequest(host, prefix, request(position)).then(
        (page) => write(key, at, (current) => ({ ...current, pages: [page, ...current.pages.slice(1)], loading: false, failure: undefined })),
        failed(key, at),
      );
      return;
    }
    // Every loaded page again, in order, each with the cursor the one before answered.
    const refetched: CollectionPage[] = [];
    const step = (cursor: string | undefined): Promise<void> =>
      fetchRequest(host, prefix, request(position, cursor)).then((page): Promise<void> | void => {
        refetched.push(page);
        const further = page.next !== null && (mode === "all" || refetched.length < loaded);
        if (further) return step(page.next as string);
        write(key, at, (current) => ({ ...current, pages: refetched, loading: false, failure: undefined }));
      }, failed(key, at));
    void step(undefined);
  };

  useEffect(() => {
    if (!visible) return;
    const current = latest.current;
    const fresh = current.query !== query;
    if (fresh) {
      const next = { query, reads: new Map<string, ReadState>() };
      latest.current = next;
      setHeld(next);
    } else {
      // A read no longer in the product is forgotten.
      const gone = [...current.reads.keys()].filter((key) => !byKey.has(key));
      if (gone.length > 0) {
        for (const key of gone) begin(key);
        setHeld((state) => {
          const reads = new Map(state.reads);
          for (const key of gone) reads.delete(key);
          return { ...state, reads };
        });
      }
    }
    const reloading = handled.current !== changes;
    handled.current = changes;
    for (const [key, position] of byKey) {
      if (fresh || !latest.current.reads.has(key)) open(key, position);
      else if (reloading) reloadOne(key, position);
    }
  }, [query, positionsKey, visible, changes]);

  const reads = useMemo(
    () =>
      [...byKey].map(([key, position]): ReadView => {
        const state = held.query === query ? held.reads.get(key) : undefined;
        const pages = state?.pages ?? [];
        const seen = new Set<string>();
        const blocks = pages.map((page) =>
          page.rows.flatMap((row) => {
            const recordKey = keyOf(row);
            if (seen.has(recordKey)) return [];
            seen.add(recordKey);
            return [{ key: recordKey, row }];
          }),
        );
        const last = pages[pages.length - 1];
        return {
          key,
          position,
          records: blocks.flat(),
          blocks,
          ...(pages[0] ? { total: pages[0].total } : {}),
          answered: pages.length > 0,
          loading: state?.loading ?? true,
          ...(state?.failure ? { failure: state.failure } : {}),
          hasMore: mode !== "pages" && last !== undefined && last.next !== null,
          loadMore: () => more(key, position),
          ...(mode === "pages" && state
            ? {
                pager: {
                  index: state.index,
                  start: state.starts[state.index] ?? 0,
                  hasPrevious: state.index > 0,
                  hasNext: !state.loading && last !== undefined && last.next !== null,
                  previous: () => state.index > 0 && show(key, position, state.index - 1),
                  next: () => last?.next != null && show(key, position, state.index + 1),
                },
              }
            : {}),
        };
      }),
    [held, query, positionsKey],
  );

  const keys = useRef(keyOf);
  keys.current = keyOf;
  const reload = useCallback(() => setChanges((count) => count + 1), []);
  const patch = useCallback((row: Row) => {
      const keyOf = keys.current;
      const recordKey = keyOf(row);
      setHeld((current) => {
        let touched = false;
        const reads = new Map<string, ReadState>();
        for (const [key, state] of current.reads) {
          const pages = state.pages.map((page) =>
            page.rows.some((each) => keyOf(each) === recordKey)
              ? ((touched = true), { ...page, rows: page.rows.map((each) => (keyOf(each) === recordKey ? row : each)) })
              : page,
          );
          reads.set(key, { ...state, pages });
        }
        if (!touched) return current;
        const next = { query: current.query, reads };
        latest.current = next;
        return next;
      });
  }, []);
  return { reads, reload, patch };
}

/** One value a grouping reads a group for: the value, as sent, and what it is shown as. */
export interface GroupValue {
  value: unknown;
  sent: string;
  /** How many records hold it, where the facet request said. */
  count?: number;
  /** The related record it names, where the values are related records. */
  option?: ChoiceOption;
}

export interface GroupValues {
  values: GroupValue[];
  loading: boolean;
  failure?: ErrorSpec;
  hasMore: boolean;
  /** Read the next page of values. */
  more(): void;
}

/**
 * The values a grouping reads a group for: its listed values, or — paged —
 * the present values the facet request answers under the listing's and the
 * bars' filters, or the related records of its relation. A change announced
 * for the listing's collection reads the facet again.
 */
export function useGroupValues(
  host: Host,
  prefix: string,
  listing: ListingReads | undefined,
  plan: ReadPlan,
  relations: Readonly<Record<string, OptionSourceSpec>>,
  visible: boolean,
  changes: number,
): GroupValues | undefined {
  const groups = plan.groups;
  const related = useMemo(() => {
    const sources: Record<string, RelatedSource> = {};
    for (const [name, spec] of Object.entries(relations)) sources[name] = { basePath: spec.basePath, pageSize: spec.pageSize };
    return sources;
  }, [relations]);
  const query = JSON.stringify([listing ?? null, groups ?? null, groups?.values === "present" ? changes : 0]);
  const [state, setState] = useState<{ query?: string; values: GroupValue[]; next: string | null; loading: boolean; failure?: ErrorSpec }>({
    values: [],
    next: null,
    loading: false,
  });
  const generation = useRef(0);

  const read = (cursor: string | undefined, append: boolean) => {
    if (!groups || !listing) return;
    const at = ++generation.current;
    const asked = valuesRequest(listing, plan, related, cursor);
    if (!asked) return;
    setState((held) => ({ ...held, query, loading: true }));
    const spec = groups.relation === undefined ? undefined : relations[groups.relation];
    const answered =
      groups.values === "present"
        ? fetchFacet(host, prefix, asked).then((page) => ({
            next: page.next,
            values: page.values.map((each) => ({ value: each.value, sent: String(each.value), count: each.count })),
          }))
        : fetchRequest(host, prefix, asked).then((page) => ({
            next: page.next,
            values: page.rows.flatMap((row) => {
              const option = spec && optionOf(spec, row);
              return option ? [{ value: option.value, sent: String(option.value), option }] : [];
            }),
          }));
    answered.then(
      (page) => {
        if (at !== generation.current) return;
        setState((held) => ({ query, values: append ? [...held.values, ...page.values] : page.values, next: page.next, loading: false }));
      },
      (error) => {
        if (at !== generation.current) return;
        setState((held) => ({ ...held, query, loading: false, failure: errorSpec(error, "ERR_UI_REQUEST_FAILED") }));
      },
    );
  };

  useEffect(() => {
    if (!visible || !groups || groups.enum) return;
    if (state.query === query) return;
    read(undefined, false);
  }, [query, visible]);

  if (!groups) return undefined;
  if (groups.enum) return { values: groups.enum.map((value) => ({ value, sent: String(value) })), loading: false, hasMore: false, more: () => {} };
  const current = state.query === query;
  return {
    values: current ? state.values : [],
    loading: !current || state.loading,
    ...(current && state.failure ? { failure: state.failure } : {}),
    hasMore: current && state.next !== null,
    more: () => {
      if (current && !state.loading && state.next !== null) read(state.next, true);
    },
  };
}

/** The product of a plan's dimensions: a read per group, per shown period, per tree level. */
export function readPositions(
  plan: ReadPlan,
  groups: GroupValues | undefined,
  period: { from: string; to: string } | undefined,
  expanded: readonly string[],
): ReadPosition[] {
  const byGroup: (string | undefined)[] = plan.groups ? (groups?.values ?? []).map((value) => value.sent) : [undefined];
  const byPeriod = plan.span ? (period ? [period] : []) : [undefined];
  const byLevel: (string | undefined)[] = plan.parent !== undefined ? [undefined, ...expanded] : [undefined];
  return byGroup.flatMap((group) =>
    byPeriod.flatMap((shown) =>
      byLevel.map((parent) => ({
        ...(group !== undefined ? { group } : {}),
        ...(shown !== undefined ? { period: shown } : {}),
        ...(parent !== undefined ? { parent } : {}),
      })),
    ),
  );
}
