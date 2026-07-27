import { useEffect, useRef, useState } from "react";
import { Check, FolderOpen, Loader2, Search } from "lucide-react";
import { type ImportableLibrary, toPascalCase } from "../loader";
import { type HubModuleHit, importSourceForHit, searchHubModules } from "../hub-search";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

interface AddImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Hub base URL (from settings); the client resolves the public default. */
  hubUrl: string | undefined;
  /** Workspace-local libraries the active module can import directly. */
  libraries: ImportableLibrary[];
  /** Aliases already bound in the active module — an add must not reuse one
   *  (a duplicate alias would silently repoint the existing import). */
  existingAliases: string[];
  /** Adds the import — resolves once persisted, rejects with a surfaced message. */
  onSubmit: (source: string, alias: string) => Promise<void>;
}

/** Suggests an unused alias by suffixing `2`, `3`, … when `base` is taken. */
function dedupeAlias(base: string, used: string[]): string {
  if (!used.includes(base)) return base;
  let i = 2;
  while (used.includes(`${base}${i}`)) i++;
  return `${base}${i}`;
}

/** A selectable import target — either a workspace library or a hub hit,
 *  normalized to the source string and a suggested alias. */
interface Candidate {
  source: string;
  alias: string;
  label: string;
}

function deriveAlias(ref: string): string {
  const tail =
    ref
      .split("/")
      .pop()
      ?.split("@")[0]
      ?.replace(/\.ya?ml$/, "") ?? "";
  return toPascalCase(tail) || "";
}

function candidateForLibrary(lib: ImportableLibrary): Candidate {
  return { source: lib.source, alias: lib.alias, label: lib.name };
}

function candidateForHit(hit: HubModuleHit): Candidate {
  return {
    source: importSourceForHit(hit),
    alias: deriveAlias(hit.module.ref),
    label: hit.module.ref,
  };
}

export function AddImportDialog({
  open,
  onOpenChange,
  hubUrl,
  libraries,
  existingAliases,
  onSubmit,
}: AddImportDialogProps) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<HubModuleHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [alias, setAlias] = useState("");
  const [aliasEdited, setAliasEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced hub search; a fresh keystroke aborts the in-flight request so a
  // slow earlier response can't overwrite a newer one.
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      setHits([]);
      setSearching(false);
      setSearchError(null);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    setSearchError(null);
    debounceRef.current = setTimeout(() => {
      searchHubModules(hubUrl, q, controller.signal)
        .then((results) => {
          setHits(results);
          setSearchError(null);
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setHits([]);
          setSearchError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      controller.abort();
    };
  }, [open, query, hubUrl]);

  function reset() {
    setQuery("");
    setHits([]);
    setSelected(null);
    setAlias("");
    setAliasEdited(false);
    setError(null);
    setSearchError(null);
    setSubmitting(false);
    setSearching(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function select(candidate: Candidate) {
    setSelected(candidate);
    setError(null);
    // Suggest an alias that doesn't collide with an existing import, so the
    // default never silently clobbers one (e.g. a second `Console` → `Console2`).
    if (!aliasEdited) setAlias(dedupeAlias(candidate.alias, existingAliases));
  }

  async function submit() {
    if (!selected) return;
    const a = alias.trim();
    if (!a) return;
    if (existingAliases.includes(a)) {
      setError(
        `Alias "${a}" is already used in this module — pick another (e.g. ${dedupeAlias(a, existingAliases)}).`,
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(selected.source, a);
      handleOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const q = query.trim();
  const localMatches = q
    ? libraries.filter(
        (lib) =>
          lib.name.toLowerCase().includes(q.toLowerCase()) ||
          lib.source.toLowerCase().includes(q.toLowerCase()),
      )
    : libraries;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-140">
        <DialogHeader>
          <DialogTitle>Add import</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-400" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the hub, or filter workspace libraries…"
              className="pl-8"
            />
          </div>

          <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
            {localMatches.length > 0 && (
              <>
                <div className="flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                  <FolderOpen className="size-3" /> This workspace
                </div>
                {localMatches.map((lib) => {
                  const active = selected?.source === lib.source;
                  return (
                    <button
                      key={lib.filePath}
                      type="button"
                      onClick={() => select(candidateForLibrary(lib))}
                      className={cardCls(active)}
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
                          {lib.name}
                        </span>
                        <span className="shrink-0 text-xs text-zinc-400">{lib.source}</span>
                        {active && (
                          <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        )}
                      </span>
                    </button>
                  );
                })}
              </>
            )}

            {q !== "" && (localMatches.length > 0 || hits.length > 0) && (
              <div className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                Hub
              </div>
            )}
            {searching && (
              <div className="flex items-center gap-2 px-1 py-2 text-xs text-zinc-500">
                <Loader2 className="size-3.5 animate-spin" /> Searching…
              </div>
            )}
            {!searching && searchError && (
              <div className="rounded border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400">
                {searchError}
              </div>
            )}
            {!searching && !searchError && q !== "" && hits.length === 0 && localMatches.length === 0 && (
              <div className="px-1 py-2 text-xs text-zinc-500">No modules found.</div>
            )}
            {!searching && q === "" && (
              <div className="px-1 py-2 text-xs text-zinc-500">
                Type to search the telo hub for modules to import.
              </div>
            )}
            {hits.map((hit) => {
              const candidate = candidateForHit(hit);
              const active = selected?.source === candidate.source;
              return (
                <button
                  key={hit.module.ref}
                  type="button"
                  onClick={() => select(candidate)}
                  className={cardCls(active)}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
                      {hit.module.ref}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                      {hit.module.version}
                    </span>
                    {active && (
                      <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    )}
                  </span>
                  {hit.module.description && (
                    <span className="line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">
                      {hit.module.description}
                    </span>
                  )}
                  {(hit.module.categories?.length ?? 0) > 0 && (
                    <span className="flex flex-wrap gap-1">
                      {hit.module.categories!.map((category) => (
                        <span
                          key={category.slug}
                          className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                        >
                          {category.label}
                        </span>
                      ))}
                    </span>
                  )}
                  {hit.matchedKinds.length > 0 && (
                    <span className="flex flex-wrap gap-1">
                      {hit.matchedKinds.slice(0, 6).map((k) => (
                        <span
                          key={k.kind}
                          className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"
                        >
                          {k.kind}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {selected && (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Alias</label>
              <Input
                value={alias}
                onChange={(e) => {
                  setAlias(e.target.value);
                  setAliasEdited(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
                placeholder="Alias"
              />
            </div>
          )}

          {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void submit()}
              disabled={!selected || !alias.trim() || submitting}
            >
              {submitting ? "Adding…" : "Add import"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function cardCls(active: boolean): string {
  return `flex flex-col gap-1 rounded border px-3 py-2 text-left transition-colors ${
    active
      ? "border-zinc-500 bg-zinc-100 dark:border-zinc-400 dark:bg-zinc-800"
      : "border-zinc-200 bg-zinc-50 hover:border-zinc-300 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
  }`;
}
