import * as React from "react";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  LayoutGrid,
  Loader2,
  Rows3,
  RotateCw,
  Search,
  SearchX,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CatalogFilterControls } from "@/CatalogFilterControls";
import {
  catalogPath,
  isNarrowed,
  NO_FILTERS,
  readFilters,
  searchRequest,
  type CatalogFilters,
} from "@/catalog-filters";
import { useHubOrigins } from "@/hub-origins";
import { cn } from "@/lib/utils";
import { hueOf } from "@/ModuleAvatar";
import { ModuleCard, RESULT_OPENER } from "@/ModuleCard";
import { ModulePreview } from "@/ModulePreview";
import { useCatalogResults, type CatalogPage } from "@/use-catalog-results";
import { useMediaQuery } from "@/use-media-query";
import {
  fetchCategories,
  fetchPublishers,
  type CategoryFacet,
  type ModuleType,
  type PublisherFacet,
  type SortOrder,
} from "@/api";

/** Debounce so a search fires once the reader pauses, not per keystroke — the
 *  hub embeds the query for the semantic arm, so each one costs real work. */
const DEBOUNCE_MS = 250;

/** Wide enough for the filter rail, the list and a preview column side by side.
 *  Below it the preview is a sheet over the list. */
const DOCKED_PREVIEW = "(min-width: 1280px)";

const VIEW_KEY = "hub.view";
type View = "list" | "grid";

/** Needs phrased the way search reads them: by what the resource should do. */
const EXAMPLE_QUERIES = [
  "store files in object storage",
  "call a language model",
  "run a job on a schedule",
  "serve an HTTP API",
  "retry a failing call",
];

/** What the server already read for this route, so the first paint — and a
 *  crawler — has the list. Either part is `null` when the hub did not answer;
 *  the page then asks again from the browser and reports what it finds. */
export interface CatalogSeed {
  facets: CategoryFacet[] | null;
  publishers: PublisherFacet[] | null;
  page: CatalogPage | null;
}

/** What a listing's rows are called: "module" covers both types. */
const NOUNS: Record<ModuleType, { one: string; many: string }> = {
  all: { one: "module", many: "modules" },
  library: { one: "library", many: "libraries" },
  application: { one: "application", many: "applications" },
};

/** How each order reads in the picker. */
const SORT_LABELS: Record<SortOrder, string> = {
  relevance: "Default order",
  name: "Name",
  recent: "Recently added",
};

/**
 * The catalogue: search, browse and filter in one surface.
 *
 * The URL is the state — `catalogPath` decides which part of it holds what —
 * so every view is a link that reloads, shares and goes Back correctly.
 * `category` and `publisher` are what the route's PATH names; a publisher may
 * also arrive in the query string, beside a category.
 */
export function Catalog({
  category,
  publisher,
  seed,
}: {
  category: string;
  publisher: string;
  seed: CatalogSeed;
}) {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { browserApiOrigin } = useHubOrigins();
  const filters = readFilters(searchParams, publisher);

  // The debounced query write runs later than the render that scheduled it, so
  // it patches the filters as they are then, not as they were.
  const latest = React.useRef(filters);
  latest.current = filters;
  const change = React.useCallback(
    (patch: Partial<CatalogFilters>) => {
      navigate(catalogPath(category, { ...latest.current, ...patch }), {
        replace: true,
        preventScrollReset: true,
      });
    },
    [navigate, category],
  );

  // The input is typed into at once and reaches the URL after a pause. `sent`
  // is the query this component last put there, which is how a change it did
  // not make — Back, a link — is told apart and adopted.
  const [input, setInput] = React.useState(filters.query);
  const sent = React.useRef(filters.query);
  React.useEffect(() => {
    if (filters.query === sent.current) return;
    sent.current = filters.query;
    setInput(filters.query);
  }, [filters.query]);
  React.useEffect(() => {
    if (input === sent.current) return;
    const timer = window.setTimeout(() => {
      sent.current = input;
      change({ query: input });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [input, change]);

  const facets = useFacet(fetchCategories, browserApiOrigin, filters.type, seed.facets);
  const publishers = useFacet(
    fetchPublishers,
    browserApiOrigin,
    filters.type,
    seed.publishers,
  );
  const results = useCatalogResults(
    browserApiOrigin,
    searchRequest(category, filters),
    seed.page ? { category, publisher, page: seed.page } : null,
  );

  const page = results.page;
  const visible = page?.hits ?? [];
  // The hub leaves these out of the listing and of its total, and says how many.
  const deprecatedHidden = page?.hidden.deprecated ?? 0;
  const hidden = deprecatedHidden + (page?.hidden.contractOnly ?? 0);
  const landing =
    !isNarrowed(category, filters) && !filters.showDeprecated && !filters.hideContractOnly;
  const categoryLabel = facets.find((f) => f.category === category)?.label || category;
  // What the list holds: a runtime narrows "all" to libraries, as the request does.
  const listed = filters.type === "all" && filters.runtime ? "library" : filters.type;
  const nouns = NOUNS[listed];

  const docked = useMediaQuery(DOCKED_PREVIEW);
  const [selectedRef, setSelectedRef] = React.useState<string | null>(null);
  // The panel opens only on an explicit pick, and closes if a new search drops
  // the module it was showing.
  const selected = visible.find((hit) => hit.module.ref === selectedRef) ?? null;

  const [view, setView] = useStoredView();
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && docked) setSelectedRef(null);
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [docked]);

  const openers = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>(`[${RESULT_OPENER}]`) ?? []);

  /** Arrows walk the cards, Space looks at one; Enter is the link's own. */
  const onListKeyDown = (event: React.KeyboardEvent) => {
    const all = openers();
    const index = all.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      all[index + 1]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index === 0) inputRef.current?.focus();
      else all[index - 1].focus();
    } else if (event.key === " ") {
      event.preventDefault();
      setSelectedRef(visible[index].module.ref);
    }
  };

  const controls = (
    <CatalogFilterControls
      category={category}
      filters={filters}
      facets={facets}
      publishers={publishers}
      total={landing && page ? page.total : null}
      onChange={change}
    />
  );
  const filterCount =
    Number(Boolean(category)) +
    Number(Boolean(filters.publisher)) +
    Number(Boolean(filters.runtime)) +
    Number(filters.type !== "all") +
    Number(filters.showDeprecated) +
    Number(filters.hideContractOnly);
  const split = docked && selected != null;
  const backTo = `${location.pathname}${location.search}`;

  // The search box sits in the hero on the landing page and at the head of the
  // results column everywhere else, where its edges are the cards' own. Those
  // are two places in the tree, so the first keystroke on the landing page
  // replaces the input the reader is typing in. Whether it held the focus is
  // read while the old one is still mounted, and the new one takes it over with
  // the caret back at the end. An example query asks for the same.
  const hadFocus =
    typeof document !== "undefined" &&
    inputRef.current !== null &&
    document.activeElement === inputRef.current;
  const focusNext = React.useRef(false);
  React.useLayoutEffect(() => {
    if (!hadFocus && !focusNext.current) return;
    focusNext.current = false;
    const element = inputRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
    // Runs when the box moves; `hadFocus` is that render's reading.
  }, [landing]);

  const searchBox = (
    <div className={cn("relative w-full", landing && "max-w-2xl")}>
      <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown") return;
          e.preventDefault();
          openers()[0]?.focus();
        }}
        placeholder="What should it do? e.g. store files in object storage"
        aria-label={`Search ${nouns.many}`}
        autoComplete="off"
        spellCheck={false}
        className={cn(
          "bg-card pr-10 pl-10 shadow-sm",
          landing && "h-12 rounded-xl text-base md:text-base",
        )}
      />
      {input ? (
        <button
          type="button"
          onClick={() => {
            setInput("");
            inputRef.current?.focus();
          }}
          aria-label="Clear search"
          className="absolute top-1/2 right-2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      ) : (
        <kbd className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded border border-border bg-muted px-1.5 font-mono text-xs text-muted-foreground sm:block">
          /
        </kbd>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-8">
      <header
        className={cn(
          "flex flex-col",
          landing ? "hero-glow -mx-4 items-center gap-4 rounded-3xl px-4 py-12 text-center sm:-mx-6 sm:px-6 sm:py-16" : "gap-3",
        )}
      >
        <h1
          className={cn(
            "font-semibold tracking-tight text-balance",
            landing ? "text-4xl sm:text-5xl" : "text-2xl",
          )}
        >
          {category
            ? categoryLabel
            : filters.publisher
              ? filters.publisher
              : landing
                ? "Find a module, on any host"
                : "Search the hub"}
        </h1>
        <p
          className={cn(
            "leading-relaxed text-muted-foreground",
            landing ? "max-w-2xl text-base text-balance" : "max-w-3xl text-sm",
          )}
        >
          {category ? (
            <>
              Every {nouns.one} declaring the <span className="font-medium">{categoryLabel}</span>{" "}
              category, across every registered host.
            </>
          ) : filters.publisher ? (
            <>
              Every {nouns.one} published on{" "}
              <span className="font-mono font-medium">{filters.publisher}</span>. A publisher is
              the host and organisation a module&apos;s ref sits under; the hub does not vouch
              for it.
            </>
          ) : (
            <>
              Federated discovery across every registered Telo module — the HTTP registry, OCI
              registries, and direct manifest URLs. Search matches on what a resource{" "}
              <em>does</em>, not just its name.
            </>
          )}
        </p>

        {landing && searchBox}

        {landing && (
          <>
            <ul className="flex max-w-2xl flex-wrap justify-center gap-1.5">
              {EXAMPLE_QUERIES.map((example) => (
                <li key={example}>
                  <button
                    type="button"
                    onClick={() => {
                      focusNext.current = true;
                      setInput(example);
                    }}
                    className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition-colors outline-none hover:border-primary/50 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {example}
                  </button>
                </li>
              ))}
            </ul>
            {page && facets.length > 0 && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground tabular-nums">{page.total}</span> modules
                in <span className="font-medium text-foreground tabular-nums">{facets.length}</span>{" "}
                categories
              </p>
            )}
          </>
        )}
      </header>

      {landing && (
        <Link
          to="/mcp"
          className="group flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-card px-4 py-3 transition-[border-color,box-shadow] outline-none hover:border-primary/40 hover:shadow-md focus-visible:ring-3 focus-visible:ring-ring/40"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Bot className="size-5" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium tracking-tight">Use the hub from your AI agent</span>
            <span className="text-sm text-muted-foreground">
              The same search, kind schemas and version pins, served over MCP — connect it once
              and your agent finds and wires modules itself.
            </span>
          </span>
          <span className="flex items-center gap-1 text-sm font-medium text-primary">
            Connect over MCP
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        </Link>
      )}

      {landing && facets.length > 0 && (
        <section className="flex flex-col gap-3">
          <SectionTitle>Browse by category</SectionTitle>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {facets.map((facet) => (
              <li key={facet.category}>
                <CategoryTile facet={facet} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <div
        className={cn(
          "grid items-start gap-8 lg:grid-cols-[14rem_minmax(0,1fr)]",
          split && "xl:grid-cols-[14rem_minmax(0,1fr)_26rem]",
        )}
      >
        <aside className="sticky top-20 hidden max-h-[calc(100dvh-6rem)] overflow-y-auto pr-1 lg:block">
          {controls}
        </aside>

        <section className="flex min-w-0 flex-col gap-4" aria-busy={results.stale}>
          {!landing && searchBox}
          <div className="flex flex-wrap items-center gap-2">
            <SectionTitle>
              {page ? (
                <>
                  {visible.length < page.total ? `${visible.length} of ${page.total}` : page.total}{" "}
                  {page.total === 1 ? nouns.one : nouns.many}
                  {hidden > deprecatedHidden && (
                    <span className="normal-case">
                      {" "}
                      · {hidden - deprecatedHidden} contract-only hidden
                    </span>
                  )}
                </>
              ) : (
                nouns.many
              )}
            </SectionTitle>
            {deprecatedHidden > 0 && (
              <button
                type="button"
                onClick={() => change({ showDeprecated: true })}
                className="rounded text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                {deprecatedHidden} deprecated hidden — show
              </button>
            )}
            {results.stale && page && (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Searching" />
            )}

            <div className="ml-auto flex items-center gap-2">
              {/* An order other than the default is for browsing: with a query
                  the hub would be ordering only its ranked candidates. */}
              {!filters.query && (
                <Select value={filters.sort} onValueChange={(sort) => change({ sort: sort as SortOrder })}>
                  <SelectTrigger aria-label="Order" className="h-8 w-44 bg-card text-[0.8rem]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(SORT_LABELS) as SortOrder[]).map((sort) => (
                      <SelectItem key={sort} value={sort}>
                        {SORT_LABELS[sort]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button
                variant="outline"
                size="sm"
                className="lg:hidden"
                onClick={() => setFiltersOpen(true)}
              >
                <SlidersHorizontal /> Filters
                {filterCount > 0 && (
                  <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">
                    {filterCount}
                  </span>
                )}
              </Button>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                spacing={0}
                value={view}
                onValueChange={(value) => {
                  if (value) setView(value as View);
                }}
                aria-label="Layout"
              >
                <ToggleGroupItem value="list" aria-label="Rows" className="data-[state=on]:bg-accent data-[state=on]:text-accent-foreground">
                  <Rows3 />
                </ToggleGroupItem>
                <ToggleGroupItem value="grid" aria-label="Cards" className="data-[state=on]:bg-accent data-[state=on]:text-accent-foreground">
                  <LayoutGrid />
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>

          {filterCount > 0 && (
            <ul className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
              {category && (
                <ActiveFilter
                  label={categoryLabel}
                  onRemove={() => navigate(catalogPath("", filters), { preventScrollReset: true })}
                />
              )}
              {filters.publisher && (
                <ActiveFilter label={filters.publisher} onRemove={() => change({ publisher: "" })} />
              )}
              {filters.type !== "all" && (
                <ActiveFilter
                  label={filters.type === "library" ? "Libraries" : "Applications"}
                  onRemove={() => change({ type: "all" })}
                />
              )}
              {filters.runtime && (
                <ActiveFilter
                  label={`Runs on ${filters.runtime === "nodejs" ? "Node" : "Rust"}`}
                  onRemove={() => change({ runtime: "" })}
                />
              )}
              {filters.showDeprecated && (
                <ActiveFilter
                  label="Including deprecated"
                  onRemove={() => change({ showDeprecated: false })}
                />
              )}
              {filters.hideContractOnly && (
                <ActiveFilter
                  label="No contract-only"
                  onRemove={() => change({ hideContractOnly: false })}
                />
              )}
              <li>
                <Link
                  to={catalogPath("", { ...NO_FILTERS, query: filters.query })}
                  preventScrollReset
                  className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Clear all
                </Link>
              </li>
            </ul>
          )}

          {page?.categoryDropped && category && (
            <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              Nothing in <span className="font-medium text-foreground">{categoryLabel}</span> matches{" "}
              <q>{filters.query}</q>, so these are the matches from every category.
            </p>
          )}

          {results.error && (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium">The hub did not answer</span>
                <span className="break-all text-muted-foreground">{results.error}</span>
              </div>
              <Button variant="outline" size="sm" onClick={results.retry}>
                <RotateCw /> Try again
              </Button>
            </div>
          )}

          {!page && !results.error && <CardSkeletons view={split ? "list" : view} />}

          {page && visible.length === 0 && !results.error && (
            <EmptyState
              nouns={nouns}
              query={filters.query}
              categoryLabel={category ? categoryLabel : ""}
              hidden={hidden}
              onShowDeprecated={
                deprecatedHidden > 0 ? () => change({ showDeprecated: true }) : undefined
              }
              filtered={filterCount > 0}
              facets={facets}
              filters={filters}
            />
          )}

          {page && visible.length > 0 && (
            <ul
              ref={listRef}
              onKeyDown={onListKeyDown}
              className={cn(
                "transition-opacity",
                results.stale && "opacity-50",
                view === "grid" && !split
                  ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
                  : "flex flex-col gap-3",
              )}
            >
              {visible.map((hit) => (
                <ModuleCard
                  key={hit.module.ref}
                  hit={hit}
                  query={filters.query}
                  compact={view === "grid" && !split}
                  selected={hit.module.ref === selectedRef}
                  backTo={backTo}
                  showTracked={filters.sort === "recent"}
                  onPreview={() => setSelectedRef(hit.module.ref)}
                />
              ))}
            </ul>
          )}

          {page && page.hits.length < page.total && (
            <Button
              variant="outline"
              className="self-center"
              disabled={results.loadingMore}
              onClick={results.loadMore}
            >
              {results.loadingMore && <Loader2 className="animate-spin" />}
              Load {Math.min(page.total - page.hits.length, page.hits.length)} more
              <span className="text-muted-foreground tabular-nums">
                {page.hits.length} / {page.total}
              </span>
            </Button>
          )}
        </section>

        {split && (
          <aside
            aria-label="Module preview"
            className="sticky top-20 hidden max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-xl border border-border bg-card p-5 xl:block"
          >
            <ModulePreview hit={selected} docked onClose={() => setSelectedRef(null)} />
          </aside>
        )}
      </div>

      <Sheet
        open={selected != null && !docked}
        onOpenChange={(open) => {
          if (!open) setSelectedRef(null);
        }}
      >
        <SheetContent aria-label="Module preview">
          {selected && (
            <ModulePreview hit={selected} docked={false} onClose={() => setSelectedRef(null)} />
          )}
        </SheetContent>
      </Sheet>

      <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
        <SheetContent side="bottom" aria-describedby={undefined}>
          <SheetTitle>Filters</SheetTitle>
          {controls}
          <Button onClick={() => setFiltersOpen(false)}>
            Show {page ? visible.length : ""} {visible.length === 1 ? nouns.one : nouns.many}
          </Button>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** One facet — categories, publishers — for the type of module being listed.
 *  The server's read is the facet over every module; a single type's is asked
 *  for when first needed. */
function useFacet<T>(
  fetcher: (origin: string, type: ModuleType, signal?: AbortSignal) => Promise<T[]>,
  origin: string,
  type: ModuleType,
  seeded: T[] | null,
): T[] {
  const [facets, setFacets] = React.useState<Record<ModuleType, T[] | null>>({
    all: seeded,
    library: null,
    application: null,
  });
  const missing = facets[type] === null;

  React.useEffect(() => {
    if (!missing) return;
    const controller = new AbortController();
    fetcher(origin, type, controller.signal)
      .then((list) => setFacets((f) => ({ ...f, [type]: list })))
      .catch(() => {
        // A facet is an optional narrowing — an unreachable hub is already
        // reported by the listing, so this stays silent rather than
        // double-reporting the same outage.
      });
    return () => controller.abort();
  }, [fetcher, origin, type, missing]);

  return facets[type] ?? [];
}

/** The reader's choice of layout, kept across visits. Rows until the browser
 *  says otherwise, so the server render never guesses. */
function useStoredView(): [View, (view: View) => void] {
  const [view, setView] = React.useState<View>("list");
  React.useEffect(() => {
    if (window.localStorage.getItem(VIEW_KEY) === "grid") setView("grid");
  }, []);
  return [
    view,
    (next) => {
      setView(next);
      window.localStorage.setItem(VIEW_KEY, next);
    },
  ];
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{children}</h2>
  );
}

function CategoryTile({ facet }: { facet: CategoryFacet }) {
  return (
    <Link
      to={catalogPath(facet.category)}
      style={{ "--h": hueOf(facet.category) } as React.CSSProperties}
      className="group flex h-full flex-col gap-2 rounded-xl border border-border bg-card p-3.5 transition-[border-color,box-shadow] outline-none hover:border-primary/40 hover:shadow-md focus-visible:ring-3 focus-visible:ring-ring/40"
    >
      <span className="module-avatar size-2.5 rounded-full" aria-hidden />
      <span className="font-medium tracking-tight group-hover:text-primary">
        {facet.label || facet.category}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {facet.modules} {facet.modules === 1 ? "module" : "modules"}
        {facet.kinds != null && ` · ${facet.kinds} ${facet.kinds === 1 ? "kind" : "kinds"}`}
      </span>
    </Link>
  );
}

function ActiveFilter({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter: ${label}`}
        className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 py-0.5 pr-1.5 pl-2.5 text-xs text-primary transition-colors outline-none hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-ring"
      >
        {label}
        <X className="size-3" />
      </button>
    </li>
  );
}

function CardSkeletons({ view }: { view: View }) {
  return (
    <ul
      aria-hidden
      className={view === "grid" ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-3" : "flex flex-col gap-3"}
    >
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className="flex gap-3 rounded-xl border border-border bg-card p-4">
          <Skeleton className="size-10 rounded-lg" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-64 max-w-full" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({
  nouns,
  query,
  categoryLabel,
  hidden,
  onShowDeprecated,
  filtered,
  facets,
  filters,
}: {
  nouns: { one: string; many: string };
  query: string;
  categoryLabel: string;
  hidden: number;
  /** Present when deprecated modules are among the hidden matches. */
  onShowDeprecated?: () => void;
  filtered: boolean;
  facets: CategoryFacet[];
  filters: CatalogFilters;
}) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <SearchX className="size-5" />
      </span>
      <div className="flex max-w-md flex-col gap-1">
        <p className="font-medium">
          No {nouns.many}{categoryLabel && <> in {categoryLabel}</>}
          {query && (
            <>
              {" "}
              match <q>{query}</q>
            </>
          )}
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {hidden > 0
            ? onShowDeprecated
              ? `${hidden} matched and ${hidden === 1 ? "is" : "are"} hidden — deprecated modules are left out unless asked for.`
              : `${hidden} matched, and your filters hide ${hidden === 1 ? "it" : "them"}.`
            : filters.type === "application"
              ? "No application registered on this hub matches yet."
              : query
                ? "Try describing what the resource should do — search matches on meaning, not just names."
                : "Nothing is registered here yet."}
        </p>
      </div>
      {onShowDeprecated && (
        <Button variant="outline" size="sm" onClick={onShowDeprecated}>
          Show deprecated modules
        </Button>
      )}
      {filtered && (
        <Button variant="outline" size="sm" asChild>
          <Link to={catalogPath("", { ...NO_FILTERS, query })} preventScrollReset>
            Clear filters
          </Link>
        </Button>
      )}
      {facets.length > 0 && (
        <ul className="flex max-w-lg flex-wrap justify-center gap-1.5">
          {facets.slice(0, 8).map((facet) => (
            <li key={facet.category}>
              <Link
                to={catalogPath(facet.category)}
                className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition-colors outline-none hover:border-primary/50 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
              >
                {facet.label || facet.category}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
