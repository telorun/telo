import type { ResourceManifest } from "@telorun/sdk";
import type { ModuleDocuments } from "./module-documents.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/** An `imports:` entry of the entry's own modules, as a diagnostic anchor. */
export interface ReachingImport {
  alias: string;
  filePath?: string;
  /** `imports.<alias>` — the entry's line in its module doc. */
  path: string;
}

/** Which of the entry's imports reaches each dependency, over the flattened
 *  `Telo.Import` documents. */
export interface ImportReach {
  /** The entry's import through which `module` is first reached — the entry's
   *  imports in declaration order, each followed through every library it
   *  reaches, however deep. Undefined for the entry's own modules and for a
   *  module no import reaches. */
  of(module: string): ReachingImport | undefined;
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

  const first = new Map<string, ReachingImport>();
  for (const entry of edges) {
    if (!isEntry(ownerOf(entry))) continue;
    const anchor: ReachingImport = {
      alias: entry.alias,
      filePath: (entry.manifest.metadata as { source?: string } | undefined)?.source,
      path: `imports.${entry.alias}`,
    };
    const seen = new Set<string>();
    const queue = [entry.target];
    while (queue.length > 0) {
      const module = queue.shift()!;
      if (seen.has(module) || rootModules.has(module)) continue;
      seen.add(module);
      if (!first.has(module)) first.set(module, anchor);
      for (const next of byOwner.get(module) ?? []) queue.push(next.target);
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
    message: `Imported library '${module}', reached through import '${via.alias}': ${message}`,
    data: { filePath: via.filePath, path: via.path },
  };
}
