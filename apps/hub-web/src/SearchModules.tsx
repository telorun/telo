import * as React from "react";
import { AlertCircle, Loader2, Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ModuleDetail } from "@/ModuleDetail";
import { moduleLabel } from "@/module-ref";
import { searchModules, type ModuleHit } from "@/api";

/** Debounce so a search fires once the author pauses, not per keystroke — the
 *  hub embeds the query for the semantic arm, so each one costs real work. */
const DEBOUNCE_MS = 250;

type State =
  | { kind: "loading" }
  | { kind: "ready"; hits: ModuleHit[] }
  | { kind: "failed"; error: string };

/** The query is mirrored into `?q=` so a search is shareable and survives a
 *  reload, without pulling in a router for a two-view app. */
function queryFromUrl(): string {
  return new URLSearchParams(window.location.search).get("q") ?? "";
}

function syncUrl(query: string) {
  const url = new URL(window.location.href);
  if (query) url.searchParams.set("q", query);
  else url.searchParams.delete("q");
  window.history.replaceState(null, "", url);
}

/** Identity of a hit for selection — a module is unique by ref. */
function hitKey(hit: ModuleHit): string {
  return hit.module.ref;
}

export function SearchModules() {
  const [query, setQuery] = React.useState(queryFromUrl);
  const [state, setState] = React.useState<State>({ kind: "loading" });
  const [selectedRef, setSelectedRef] = React.useState<string | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setState({ kind: "loading" });
      try {
        const result = await searchModules(query, controller.signal);
        setState(
          result.ok ? { kind: "ready", hits: result.hits } : { kind: "failed", error: result.error },
        );
      } catch {
        // Aborted by a newer keystroke — the newer run owns the state.
      }
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  React.useEffect(() => syncUrl(query), [query]);

  const hits = state.kind === "ready" ? state.hits : [];
  // The drawer opens only on an explicit pick — no auto-selection, or a fresh
  // search would pop it open unbidden. It closes if a re-search drops the module.
  const selected = hits.find((h) => hitKey(h) === selectedRef) ?? null;

  return (
    <div className="flex flex-col gap-5">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="What should it do? e.g. store files in object storage"
          aria-label="Search modules"
          autoComplete="off"
          spellCheck={false}
          className="pl-9"
        />
      </div>

      {state.kind === "loading" && (
        <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Searching…
        </p>
      )}

      {state.kind === "failed" && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium">Search unavailable</span>
            <span className="break-all text-muted-foreground">{state.error}</span>
          </div>
        </div>
      )}

      {state.kind === "ready" && hits.length === 0 && (
        <p className="py-6 text-sm text-muted-foreground">
          No modules match {query ? <q className="font-medium">{query}</q> : "that"}. Try describing
          what the resource should <em>do</em> — search matches on meaning, not just names.
        </p>
      )}

      {state.kind === "ready" && hits.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {hits.map((hit) => (
            <li key={hitKey(hit)}>
              <button
                type="button"
                onClick={() => setSelectedRef(hitKey(hit))}
                className="flex w-full flex-col gap-0.5 rounded-lg border border-transparent px-3 py-2 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <div className="flex w-full items-baseline gap-x-3">
                  <span className="truncate font-medium">{moduleLabel(hit.module.ref)}</span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    v{hit.module.version}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                    {hit.matchedKinds.length} {hit.matchedKinds.length === 1 ? "kind" : "kinds"}
                  </span>
                </div>
                <span className="line-clamp-2 w-full text-sm leading-snug text-muted-foreground">
                  {hit.module.description || hit.module.ref}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Sheet
        open={selected != null}
        onOpenChange={(open) => {
          if (!open) setSelectedRef(null);
        }}
      >
        <SheetContent aria-label="Module details">
          {selected && <ModuleDetail hit={selected} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}
