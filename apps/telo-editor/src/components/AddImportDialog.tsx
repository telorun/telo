import { parseVersionedRef, withRefVersion } from "@telorun/analyzer";
import {
  describeReason,
  selectCompatibleVersion,
  type IncompatibilityReason,
  type ModuleVersionLookup,
  type VersionCompatibilityCheck,
} from "@telorun/ide-support";
import { useEffect, useRef, useState } from "react";
import { Check, FolderOpen, Loader2, Search, TriangleAlert } from "lucide-react";
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
  /** Version enumeration, shared with the rest of the Imports view so one
   *  module is looked up once however many affordances ask about it. */
  listVersions: ModuleVersionLookup;
  /** Whether this telo can host a given version — shared with the rest of the
   *  Imports view so its per-version answers are asked once. An import added at
   *  a version this runtime cannot load is a manifest that fails at the load
   *  gate seconds later, so the choice is made here rather than discovered
   *  there. */
  isCompatible: VersionCompatibilityCheck;
  /** Adds the import — resolves once persisted, rejects with a surfaced message. */
  onSubmit: (source: string, alias: string) => Promise<void>;
}

/** What the dialog resolved the selected candidate's version to.
 *
 *  `downgraded` — the newest published version needs a newer telo, so an older
 *  one is offered instead. `none` — nothing published runs here; the newest is
 *  still offered, because refusing to add anything would leave the author with
 *  no way to express the dependency at all, and the load gate reports it
 *  loudly. Either way the dialog says so before the click. */
type VersionResolution =
  | { status: "checking" }
  | { status: "ok" }
  | { status: "downgraded"; version: string; held: string; reason: IncompatibilityReason }
  | { status: "none"; held: string; reason: IncompatibilityReason };

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
  /** Stable identity of the offered module, independent of which version the
   *  dialog settles on. Selection is tracked by this, not by `source`, which
   *  moves when the version check re-points the candidate at an older
   *  release — comparing sources there would silently drop the highlight off
   *  the row the user just clicked. */
  key: string;
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
  return { key: lib.source, source: lib.source, alias: lib.alias, label: lib.name };
}

function candidateForHit(hit: HubModuleHit): Candidate {
  return {
    key: hit.module.ref,
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
  listVersions,
  isCompatible,
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
  const [resolution, setResolution] = useState<VersionResolution>({ status: "ok" });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Only the newest selection may paint its resolution — selecting a second
  // candidate while the first is still resolving must not adopt its answer.
  const resolveId = useRef(0);

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
    setResolution({ status: "ok" });
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
    void resolveVersion(candidate);
  }

  /** Re-points a versioned candidate at the newest version this telo can host.
   *  A workspace library (a path, no version) resolves to itself. */
  async function resolveVersion(candidate: Candidate) {
    const id = ++resolveId.current;
    const ref = parseVersionedRef(candidate.source);
    if (!ref) {
      setResolution({ status: "ok" });
      return;
    }
    setResolution({ status: "checking" });
    try {
      const versions = await listVersions(ref.baseRef);
      const { best, heldBack } = await selectCompatibleVersion(
        ref.baseRef,
        versions,
        null,
        isCompatible,
      );
      if (resolveId.current !== id) return;
      if (!best) {
        // Nothing published runs here. The newest is still what gets added —
        // refusing outright would leave the author unable to express the
        // dependency at all — but the dialog says so before the click.
        setResolution(
          heldBack
            ? { status: "none", held: heldBack.version, reason: heldBack.reason }
            : { status: "ok" },
        );
        return;
      }
      setSelected({ ...candidate, source: withRefVersion(candidate.source, best.version) });
      setResolution(
        heldBack
          ? {
              status: "downgraded",
              version: best.version,
              held: heldBack.version,
              reason: heldBack.reason,
            }
          : { status: "ok" },
      );
    } catch {
      // An unreachable hub must not block adding an import: the candidate keeps
      // the version the search reported, and the load gate still checks it.
      if (resolveId.current === id) setResolution({ status: "ok" });
    }
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
                  const active = selected?.key === lib.source;
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
              const active = selected?.key === candidate.key;
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

          {selected && resolution.status === "downgraded" && (
            <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Adding {resolution.version} — {resolution.held} is newer but{" "}
                {describeReason(resolution.reason)}.
              </span>
            </p>
          )}

          {selected && resolution.status === "none" && (
            <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>
                No published version runs on this telo ({resolution.held} is the newest and{" "}
                {describeReason(resolution.reason)}). Adding it anyway will not load until telo is
                updated.
              </span>
            </p>
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
              // Held while the version resolves: clicking early would write the
              // version the search reported rather than the one that runs here.
              disabled={!selected || !alias.trim() || submitting || resolution.status === "checking"}
            >
              {submitting ? "Adding…" : resolution.status === "checking" ? "Checking…" : "Add import"}
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
