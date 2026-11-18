/**
 * What a graph reports of its library migration stage, and how the stage bears
 * on the analysis after it: the entry's own files report every migration that
 * fired at the node it rewrote, and every `MIGRATION_FAILED`; a dependency's
 * file reports its `MIGRATION_FAILED` alone, at the entry's `imports:` entry
 * reaching it. A failed node is left as written, so the current-schema
 * findings beneath it are held back; a finding beneath a rewritten node whose
 * path the author's tree does not hold is reported at the node.
 *
 * Browser-safe: no Node built-ins.
 */
import { filesOf, moduleNameOf } from "../loaded-kind-scope.js";
import type { LoadedGraph } from "../loaded-types.js";
import { reachedModuleSources } from "../module-origin.js";
import { importAnchoredDiagnostic } from "../reaching-import.js";
import { DiagnosticSeverity, DiagnosticTag, type AnalysisDiagnostic } from "../types.js";
import { renderValuePath, type ValuePath } from "../value-schema-walk.js";
import type { MigrationTreePointer } from "./edit-record.js";
import type { LibraryMigrationFinding } from "./stage.js";

const SOURCE = "telo-analyzer";

const SEVERITIES = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
  hint: DiagnosticSeverity.Hint,
} as const;

/** The structured data a library migration's diagnostic carries. */
export interface LibraryMigrationDiagnosticData {
  /** The module declaring the migration, and its source as requested. */
  readonly module: string;
  readonly source: string;
  /** The owner source of the module whose file holds the node. */
  readonly modulePath: string;
  /** `MIGRATION_FAILED` only: the failing migration's code (the first by code order when several are named). */
  readonly migration?: string;
  /** `MIGRATION_FAILED` only: every migration code the failure names. */
  readonly migrations?: readonly string[];
  /** `MIGRATION_FAILED` only: the bare cause, without the message's prefix. */
  readonly cause?: string;
}

function documentOf(graph: LoadedGraph, file: string, document: number): Record<string, unknown> | undefined {
  for (const mod of graph.modules.values()) {
    for (const f of filesOf(mod)) {
      if (f.source === file) return (f.manifests[document] ?? undefined) as Record<string, unknown> | undefined;
    }
  }
  return undefined;
}

function resourceOf(graph: LoadedGraph, at: MigrationTreePointer): { kind: string; name: string } | undefined {
  const doc = documentOf(graph, at.file, at.document);
  const kind = doc?.kind;
  const name = (doc?.metadata as { name?: unknown } | undefined)?.name;
  return typeof kind === "string" && typeof name === "string" ? { kind, name } : undefined;
}

/** The alias of the entry's own imports through which `moduleSource` is reached. */
function entryAliasReaching(graph: LoadedGraph, moduleSource: string): { alias: string; filePath: string } | undefined {
  for (const file of filesOf(graph.entry)) {
    for (const [alias, edge] of graph.importEdges.get(file.source) ?? []) {
      if (reachedModuleSources(graph, edge.targetSource).has(moduleSource)) return { alias, filePath: file.source };
    }
  }
  return undefined;
}

/** The diagnostics `graph` reports of its library migration stage. */
export function libraryMigrationDiagnostics(graph: LoadedGraph): AnalysisDiagnostic[] {
  const outcome = graph.libraryMigrations;
  if (!outcome) return [];
  const entryFiles = new Set(filesOf(graph.entry).map((f) => f.source));
  const inGraph = new Set([...graph.modules.values()].flatMap((m) => filesOf(m).map((f) => f.source)));
  const out: AnalysisDiagnostic[] = [];
  const seen = new Set<string>();
  for (const finding of outcome.findings) {
    if (!inGraph.has(finding.at.file)) continue;
    const libraryMigration: LibraryMigrationDiagnosticData = {
      ...finding.library,
      modulePath: finding.modulePath,
      ...(finding.migration !== undefined ? { migration: finding.migration } : {}),
      ...(finding.migrations !== undefined ? { migrations: finding.migrations } : {}),
      ...(finding.cause !== undefined ? { cause: finding.cause } : {}),
    };
    if (entryFiles.has(finding.at.file)) {
      const path = renderValuePath(finding.at.path);
      const key = `${finding.at.file}\0${finding.at.document}\0${path}\0${finding.code}\0${finding.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const resource = resourceOf(graph, finding.at);
      out.push({
        severity: SEVERITIES[finding.severity],
        code: finding.code,
        source: SOURCE,
        ...(finding.code === "MIGRATION_FAILED" ? {} : { tags: [DiagnosticTag.Deprecated] }),
        message: finding.message,
        data: { filePath: finding.at.file, path, ...(resource ? { resource } : {}), libraryMigration },
      });
      continue;
    }
    if (finding.code !== "MIGRATION_FAILED") continue;
    const via = entryAliasReaching(graph, finding.modulePath);
    const holder = graph.modules.get(finding.modulePath);
    if (!via || !holder) continue;
    const resource = resourceOf(graph, finding.at);
    const anchored = importAnchoredDiagnostic(
      finding.code,
      moduleNameOf(holder) ?? finding.modulePath,
      { alias: via.alias, filePath: via.filePath, path: `imports.${via.alias}` },
      finding.message,
      { ...(resource ? { resource } : {}), filePath: finding.at.file, path: renderValuePath(finding.at.path) },
    );
    const key = `${via.filePath}\0${via.alias}\0${anchored.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...anchored, data: { ...(anchored.data as object), libraryMigration } });
  }
  return out;
}

const PATH_SEGMENT = /([^.[\]]+)|\[(\d+)\]/g;

function parsePath(path: string): ValuePath {
  const out: (string | number)[] = [];
  for (const match of path.matchAll(PATH_SEGMENT)) out.push(match[2] !== undefined ? Number(match[2]) : match[1]!);
  return out;
}

const startsWith = (path: ValuePath, prefix: ValuePath) =>
  prefix.length <= path.length && prefix.every((segment, i) => path[i] === segment);

function valueAt(value: unknown, path: ValuePath): unknown {
  let at = value;
  for (const segment of path) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string | number, unknown>)[segment];
  }
  return at;
}

/**
 * `analysis` with the findings beneath a node a migration failed on held back,
 * and a finding beneath a rewritten node, at a path the author's tree does not
 * hold, reported at that node.
 */
export function withLibraryMigrationsApplied(
  graph: LoadedGraph,
  analysis: readonly AnalysisDiagnostic[],
): AnalysisDiagnostic[] {
  const outcome = graph.libraryMigrations;
  if (!outcome || (outcome.failed.length === 0 && outcome.rewritten.length === 0)) return [...analysis];
  const located = (d: AnalysisDiagnostic) => {
    const data = d.data as { resource?: { name?: unknown }; filePath?: string; path?: unknown } | undefined;
    const name = data?.resource?.name;
    if (typeof name !== "string" || typeof data?.path !== "string") return undefined;
    return { name, filePath: data.filePath, path: parsePath(data.path) };
  };
  const named = (pointer: MigrationTreePointer) => {
    const doc = documentOf(graph, pointer.file, pointer.document);
    return (doc?.metadata as { name?: unknown } | undefined)?.name;
  };
  const matches = (pointer: MigrationTreePointer, at: NonNullable<ReturnType<typeof located>>) =>
    named(pointer) === at.name && (at.filePath === undefined || at.filePath === pointer.file) && startsWith(at.path, pointer.path);
  const out: AnalysisDiagnostic[] = [];
  for (const d of analysis) {
    const at = d.code === "MIGRATION_FAILED" ? undefined : located(d);
    if (at && outcome.failed.some((pointer) => matches(pointer, at))) continue;
    const anchor = at ? outcome.rewritten.find((pointer) => matches(pointer, at)) : undefined;
    if (anchor && at && at.path.length > anchor.path.length) {
      const original = outcome.originals.get(anchor.file)?.[anchor.document];
      if (valueAt(original, at.path) === undefined) {
        out.push({ ...d, data: { ...(d.data as object), path: renderValuePath(anchor.path) } });
        continue;
      }
    }
    out.push(d);
  }
  return out;
}
