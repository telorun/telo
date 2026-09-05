/**
 * The pure half of reconciliation: what a second load of the same entry changed,
 * at the granularity of whole modules.
 *
 * The per-RESOURCE answer is the analyzer's (`diffManifests`), and it is exact.
 * This is the coarser question that has to be asked first, because the kernel's
 * runtime manifest set is entry-only: an imported library's resources live in
 * the child context its `Telo.Import` owns and never appear in the set the
 * resource diff walks. A library edit is therefore invisible to that diff, and
 * would silently reconcile to "nothing changed".
 *
 * So the modules are compared by content, and anything moving outside the entry
 * escalates rather than being narrowed. That is the same posture the opaque-read
 * escalation takes: a fallback to rebuilding, which is what a host does today.
 */
import type { LoadedGraph, LoadedModule } from "@telorun/analyzer";

/** What one {@link reconcile} pass did, or why it could not narrow. */
export interface ReconcileOutcome {
  /** Resources rebuilt: the declarations that moved, plus everything that was
   *  holding one of them. */
  readonly reinitialized: readonly string[];
  /** Resources whose declaration is gone. Unwound, not replaced. */
  readonly removed: readonly string[];
  /** Set when the change had no bounded impact set and the caller must rebuild
   *  the kernel. Nothing has been unwound when this is present. */
  readonly restartRequired?: string;
}

/** Every file the graph read, so a caller can drop them from the loader's cache
 *  before asking for them again. `Loader.loadFile` assumes a file's contents do
 *  not change under one Loader, which is exactly the assumption a reload
 *  breaks. */
export function graphFileSources(graph: LoadedGraph): string[] {
  const sources = new Set<string>();
  for (const module of graph.modules.values()) {
    sources.add(module.owner.source);
    for (const partial of module.partials) sources.add(partial.source);
  }
  sources.add(graph.entry.owner.source);
  for (const partial of graph.entry.partials) sources.add(partial.source);
  return [...sources];
}

/** A module's content: every file it is made of, as text.
 *
 *  Compared as a string rather than hashed — there is no collision to reason
 *  about, and a missed change here is a library that silently keeps running
 *  against source it no longer matches. */
function moduleSignature(module: LoadedModule): string {
  return [module.owner, ...module.partials]
    .map((file) => `${file.source}\u0000${file.text}`)
    .join("\u0000\u0000");
}

/**
 * Modules other than the entry whose content moved between two loads, including
 * ones that appeared or disappeared.
 *
 * The entry is excluded because the resource diff answers for it precisely.
 * Everything else is a library, whose resources this kernel cannot see
 * individually.
 */
export function modulesThatMoved(previous: LoadedGraph, next: LoadedGraph): string[] {
  const before = new Map<string, string>();
  for (const [source, module] of previous.modules) {
    if (source === previous.rootSource) continue;
    before.set(source, moduleSignature(module));
  }

  const moved: string[] = [];
  const seen = new Set<string>();
  for (const [source, module] of next.modules) {
    if (source === next.rootSource) continue;
    seen.add(source);
    const was = before.get(source);
    if (was === undefined || was !== moduleSignature(module)) moved.push(source);
  }
  for (const source of before.keys()) {
    if (!seen.has(source)) moved.push(source);
  }
  return moved;
}
