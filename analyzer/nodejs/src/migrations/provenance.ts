/** Path provenance — part of the driver's contract, not an optional extra.
 *
 *  `resolveRange` looks a diagnostic's dotted path up in a position index built
 *  from the RAW file, then falls back to the parent's key or value range. Every
 *  rewrite that existed before migrations preserved paths; a `rename-key` is
 *  the first that does not, and without a remap every downstream diagnostic on
 *  that node degrades to a parent squiggle — with a `DiagnosticFix` over a
 *  single-line parent value writing a whole value across it.
 *
 *  So each rewrite records the legacy path it matched alongside the migrated
 *  one, and diagnostics are remapped through that record before position
 *  resolution. This is the generalization of `rewriteSyntheticOrigins`, which
 *  already rewrites `data.path` so lookups resolve after
 *  `normalizeInlineResources` has moved a resource. */

import type { AnalysisDiagnostic } from "../types.js";
import type { LoadedGraph } from "../loaded-types.js";
import type { MigrationRewrite } from "./types.js";

/** One rewrite, with everything a diagnostic could be routed by.
 *
 *  A diagnostic carries at most two routing facts — the file it is in and the
 *  resource it is about — and it routinely carries only one. So a record keeps
 *  both, and both indexes below are built over the same records. */
interface RewriteRecord {
  readonly source: string;
  readonly kind?: string;
  readonly name?: string;
  readonly rewrite: MigrationRewrite;
}

/** Records reachable by each routing fact.
 *
 *  `byFile` is the general index: every rewrite is in it, so a diagnostic that
 *  names only its file is still remapped. Indexing by identity ALONE was the
 *  hole this closes — a diagnostic with no `data.resource` (a module-level one)
 *  and a rewrite in a document with no `metadata.name` (every `Telo.Import`)
 *  were both simply unreachable.
 *
 *  `byIdentity` is the NARROWING index, not a substitute: `(kind, name)` is not
 *  an identity across a graph, since resource names are module-scoped and two
 *  modules routinely declare the same one (`Store`, `Connection`, …). Applying
 *  one module's record to another's diagnostic is exactly how a squiggle lands
 *  on an unrelated node — the failure this pass exists to prevent. */
interface RewriteIndex {
  readonly byFile: Map<string, RewriteRecord[]>;
  readonly byIdentity: Map<string, RewriteRecord[]>;
  readonly size: number;
}

function identityKey(kind: string, name: string): string {
  return `${kind}\0${name}`;
}

function push(index: Map<string, RewriteRecord[]>, key: string, record: RewriteRecord): void {
  const bucket = index.get(key);
  if (bucket) bucket.push(record);
  else index.set(key, [record]);
}

function buildIndex(graph: LoadedGraph): RewriteIndex {
  const byFile = new Map<string, RewriteRecord[]>();
  const byIdentity = new Map<string, RewriteRecord[]>();
  let size = 0;
  for (const mod of graph.modules.values()) {
    for (const file of [mod.owner, ...mod.partials]) {
      for (const rewrite of file.migrations.rewrites) {
        const manifest = file.manifests[rewrite.documentIndex];
        const kind = typeof manifest?.kind === "string" ? manifest.kind : undefined;
        const name = typeof manifest?.metadata?.name === "string" ? manifest.metadata.name : undefined;
        const record: RewriteRecord = { source: file.source, kind, name, rewrite };
        push(byFile, file.source, record);
        if (kind !== undefined && name !== undefined) {
          push(byIdentity, identityKey(kind, name), record);
        }
        size++;
      }
    }
  }
  return { byFile, byIdentity, size };
}

/** The records a diagnostic may be remapped against, narrowed by whichever
 *  routing facts it carries. `undefined` means "cannot be narrowed to one
 *  file", the one case where no answer is better than a guess. */
function candidatesFor(
  index: RewriteIndex,
  filePath: string | undefined,
  kind: string | undefined,
  name: string | undefined,
): RewriteRecord[] | undefined {
  if (kind !== undefined && name !== undefined) {
    const records = index.byIdentity.get(identityKey(kind, name));
    if (!records) return undefined;
    if (filePath !== undefined) return records.filter((r) => r.source === filePath);
    // Several files declare this identity and the diagnostic names none of
    // them. Guessing would move a squiggle onto an unrelated node, which is
    // worse than the parent-squiggle fallback leaving it where it is.
    return new Set(records.map((r) => r.source)).size > 1 ? undefined : records;
  }
  if (filePath !== undefined) return index.byFile.get(filePath);
  return undefined;
}

/** `path` with the longest matching migrated prefix swapped back to the legacy
 *  spelling, or `undefined` when no rewrite touched it. Longest-prefix wins so
 *  a rewrite nested inside another resolves against the innermost one.
 *
 *  Two records covering the same path with DIFFERENT legacy spellings are
 *  ambiguous — a file-scoped candidate set spans every document in the file,
 *  and two documents can share a path. Refusing beats picking one. */
function remapPath(path: string, records: readonly RewriteRecord[]): string | undefined {
  let best: MigrationRewrite | undefined;
  let ambiguous = false;
  for (const { rewrite } of records) {
    const migrated = rewrite.migratedPath;
    if (migrated === rewrite.legacyPath) continue;
    const covers =
      path === migrated || path.startsWith(`${migrated}.`) || path.startsWith(`${migrated}[`);
    if (!covers) continue;
    if (!best || migrated.length > best.migratedPath.length) {
      best = rewrite;
      ambiguous = false;
    } else if (
      migrated.length === best.migratedPath.length &&
      rewrite.legacyPath !== best.legacyPath
    ) {
      ambiguous = true;
    }
  }
  if (!best || ambiguous) return undefined;
  return best.legacyPath + path.slice(best.migratedPath.length);
}

/**
 * Rewrite every diagnostic's `data.path` from the migrated spelling back to
 * what the author wrote, so position lookups against the raw file resolve.
 *
 * A no-op — and returns the input array — when nothing in the graph was
 * migrated, which is the overwhelmingly common case.
 */
export function remapMigratedPaths(
  graph: LoadedGraph,
  diagnostics: readonly AnalysisDiagnostic[],
): AnalysisDiagnostic[] {
  const index = buildIndex(graph);
  if (index.size === 0) return [...diagnostics];

  return diagnostics.map((d) => {
    const data = d.data as
      | { resource?: { kind?: string; name?: string }; path?: string; filePath?: string }
      | undefined;
    if (typeof data?.path !== "string") return d;

    const records = candidatesFor(
      index,
      typeof data.filePath === "string" ? data.filePath : undefined,
      typeof data.resource?.kind === "string" ? data.resource.kind : undefined,
      typeof data.resource?.name === "string" ? data.resource.name : undefined,
    );
    if (!records || records.length === 0) return d;

    const remapped = remapPath(data.path, records);
    if (remapped === undefined || remapped === data.path) return d;
    return { ...d, data: { ...data, path: remapped } };
  });
}
