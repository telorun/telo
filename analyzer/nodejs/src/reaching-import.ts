import type { ResourceManifest } from "@telorun/sdk";
import { scopedImportMembers } from "./flatten-for-analyzer.js";
import type { ModuleDocuments } from "./module-documents.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/** An `imports:` entry of the entry's own modules — or a `Telo.Import` one of
 *  them declares as a scope member — as a diagnostic anchor. */
export interface ReachingImport {
  alias: string;
  filePath?: string;
  /** `imports.<alias>` — the entry's line in its module doc; for a scope
   *  member, its place in its top-level holder (`with[0]`). */
  path: string;
  /** The top-level holder of a scope member's import. */
  resource?: { kind: string; name: string };
}

/** Which of the entry's imports reaches each dependency, over the flattened
 *  `Telo.Import` documents. */
export interface ImportReach {
  /** The entry's import through which `module` is first reached — the entry's
   *  imports in declaration order, each followed through every library it
   *  reaches, however deep. Undefined for the entry's own modules and for a
   *  module no import reaches. */
  of(module: string): ReachingImport | undefined;
  /** The aliases leading from the entry to `module` along the import edges
   *  that first reach it (the instance path of an isolated library). */
  pathOf(module: string): readonly string[] | undefined;
  /** Whether these are the documents the application loads under their module
   *  name: an import reaches them by source, never a version reconciliation
   *  replaced. An import carrying no resolved source accepts any. */
  loads(documents: Pick<ModuleDocuments, "module" | "sourceId">): boolean;
}

interface ImportEdge {
  manifest: ResourceManifest;
  alias: string;
  target: string;
  source?: string;
}

/**
 * Where a dependency's refusal is reported: at the entry's `imports:` entry
 * through which the dependency is first reached, since the kernel refuses the
 * consumer all the same and that is the line the consumer can act on.
 */
export function importReach(
  manifests: readonly ResourceManifest[],
  rootModules: ReadonlySet<string>,
): ImportReach {
  const edges: ImportEdge[] = [];
  for (const m of manifests) {
    if (m.kind !== "Telo.Import") continue;
    const meta = m.metadata as { name?: unknown; resolvedModuleName?: string; resolvedSource?: string };
    if (typeof meta?.name !== "string" || !meta.resolvedModuleName) continue;
    edges.push({
      manifest: m,
      alias: meta.name,
      target: meta.resolvedModuleName,
      ...(meta.resolvedSource ? { source: meta.resolvedSource } : {}),
    });
  }
  const ownerOf = (edge: ImportEdge) =>
    (edge.manifest.metadata as { module?: string } | undefined)?.module;
  const isEntry = (module: string | undefined) => !module || rootModules.has(module);

  const byOwner = new Map<string, ImportEdge[]>();
  for (const edge of edges) {
    const owner = ownerOf(edge);
    if (owner === undefined) continue;
    const list = byOwner.get(owner);
    if (list) list.push(edge);
    else byOwner.set(owner, [edge]);
  }

  // The entry's `imports:` entries first, then the imports its declarations
  // hold as scope members, each anchored at the member inside its holder.
  const entries: { edge: ImportEdge; anchor: ReachingImport; path: string[] }[] = [];
  for (const entry of edges) {
    if (!isEntry(ownerOf(entry))) continue;
    entries.push({
      edge: entry,
      anchor: {
        alias: entry.alias,
        filePath: (entry.manifest.metadata as { source?: string } | undefined)?.source,
        path: `imports.${entry.alias}`,
      },
      path: [entry.alias],
    });
  }
  for (const { member, top, path } of scopedImportMembers(manifests)) {
    const topMeta = top.metadata as { name?: string; source?: string; module?: string } | undefined;
    const meta = member.metadata as {
      name?: unknown;
      resolvedModuleName?: string;
      resolvedSource?: string;
      scopeHolders?: string[];
    };
    if (!isEntry(topMeta?.module) || typeof meta.name !== "string" || !meta.resolvedModuleName) continue;
    const edge: ImportEdge = {
      manifest: member,
      alias: meta.name,
      target: meta.resolvedModuleName,
      ...(meta.resolvedSource ? { source: meta.resolvedSource } : {}),
    };
    edges.push(edge);
    entries.push({
      edge,
      anchor: {
        alias: meta.name,
        filePath: topMeta?.source,
        path,
        resource: { kind: top.kind as string, name: topMeta?.name as string },
      },
      path: [...(meta.scopeHolders ?? []), meta.name],
    });
  }

  const first = new Map<string, ReachingImport>();
  const paths = new Map<string, string[]>();
  for (const { edge: entry, anchor, path: entryPath } of entries) {
    const seen = new Set<string>();
    const queue: { module: string; path: string[] }[] = [{ module: entry.target, path: entryPath }];
    while (queue.length > 0) {
      const { module, path } = queue.shift()!;
      if (seen.has(module) || rootModules.has(module)) continue;
      seen.add(module);
      if (!first.has(module)) {
        first.set(module, anchor);
        paths.set(module, path);
      }
      for (const next of byOwner.get(module) ?? []) queue.push({ module: next.target, path: [...path, next.alias] });
    }
  }

  const sources = new Map<string, Set<string | undefined>>();
  for (const edge of edges) {
    const set = sources.get(edge.target);
    if (set) set.add(edge.source);
    else sources.set(edge.target, new Set([edge.source]));
  }

  return {
    of: (module) => first.get(module),
    pathOf: (module) => paths.get(module),
    loads: ({ module, sourceId }) => {
      const reaching = sources.get(module);
      return !!reaching && (reaching.has(sourceId) || reaching.has(undefined));
    },
  };
}

/** A dependency's refusal, at the entry's import reaching it. */
export function importAnchoredDiagnostic(
  code: string,
  module: string,
  via: ReachingImport,
  message: string,
): AnalysisDiagnostic {
  return {
    severity: DiagnosticSeverity.Error,
    code,
    source: SOURCE,
    message: importAnchoredMessage(module, via.alias, message),
    data: { filePath: via.filePath, path: via.path, ...(via.resource ? { resource: via.resource } : {}) },
  };
}

/** The wording of every refusal of `module` reported at the import `alias`. */
export function importAnchoredMessage(module: string, alias: string, message: string): string {
  return `Imported library '${module}', reached through import '${alias}': ${message}`;
}
