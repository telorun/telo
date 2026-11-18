import type { ResourceManifest } from "@telorun/sdk";
import { AnalysisRegistry } from "./analysis-registry.js";
import { StaticAnalyzer } from "./analyzer.js";
import { flattenForAnalyzer } from "./flatten-for-analyzer.js";
import { registerLoadedGraph } from "./graph-registration.js";
import { importsOfLibrary, libraryDocumentOf, reachableByImports } from "./dependency-configurations.js";
import { assembleEntryDiagnostics } from "./entry-diagnostics.js";
import { defectIdentity, writtenPlaceOf } from "./diagnostic-identity.js";
import { collectFilePositions } from "./diagnostic-location.js";
import type { ImportEdge, LoadedGraph, ScopedImportEdge } from "./loaded-types.js";
import { isModuleKind } from "./module-kinds.js";
import { moduleOrigins, reachedModuleSources, type ModuleOrigin } from "./module-origin.js";
import { metadataStampDiagnostics } from "./metadata-stamp-refusals.js";
import { importAnchoredDiagnostic, importReach, type ReachingImport } from "./reaching-import.js";
import type { HostVersions } from "./requires-block.js";
import { isTaggedSentinel } from "@telorun/templating";
import { FOUND_HEAD, foundEntryOf } from "./module-file-existence.js";
import { sha256Base64Url } from "./sources/integrity.js";
import { TELO_RUNNING_SURFACE } from "./telo-version.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

/**
 * The dependency stage: every library an application loads is judged by its
 * OWN entry analysis — the verdict `telo check <library>` gives — and that
 * verdict is folded into the application's result, anchored by the library's
 * origin (`module-origin.ts`): an editable library's findings at its own lines,
 * every severity; an artifact's errors alone, as warnings at the entry's import
 * reaching it (the consumer cannot act on a published library's own defects).
 * A finding holding only in configurations no import of the library reaches is
 * dropped.
 *
 * A verdict depends on the library's closure alone — what an importer supplies
 * is judged at the import, by the application's own analysis — so it is
 * memoized by a digest of that closure and the analyzer's version, in process
 * and through a host-supplied store. Browser-safe: it touches no filesystem.
 */

/** One library's own verdict: what its entry analysis reports, before origin
 *  and configurations are applied. Plain data. */
export interface DependencyVerdict {
  /** The verdict format it was judged in; a kept verdict of another is judged
   *  again. */
  readonly format: number;
  readonly module: string;
  readonly diagnostics: readonly AnalysisDiagnostic[];
}

/** Where a host keeps verdicts between processes, by {@link dependencyVerdictKey}.
 *  A key covers the closure's files, its import resolution, the host versions
 *  and the analyzer version; a host analysing with different CEL handlers keeps
 *  a store of its own. */
export interface DependencyVerdictStore {
  get(key: string): DependencyVerdict | undefined | Promise<DependencyVerdict | undefined>;
  set(key: string, verdict: DependencyVerdict): void | Promise<void>;
}

/** The store that keeps nothing. */
export const NO_DEPENDENCY_VERDICT_STORE: DependencyVerdictStore = {
  get: () => undefined,
  set: () => undefined,
};

/** In-process verdicts, by key, the least recently used dropped beyond
 *  `capacity`. A verdict being computed is shared by every caller asking. */
export class DependencyVerdictMemo {
  private readonly entries = new Map<string, Promise<DependencyVerdict>>();

  constructor(readonly capacity = 256) {}

  obtain(key: string, compute: () => Promise<DependencyVerdict>): Promise<DependencyVerdict> {
    const known = this.entries.get(key);
    if (known) {
      this.entries.delete(key);
      this.entries.set(key, known);
      return known;
    }
    const pending = compute();
    this.entries.set(key, pending);
    pending.catch(() => {
      if (this.entries.get(key) === pending) this.entries.delete(key);
    });
    while (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    return pending;
  }
}

const PROCESS_VERDICTS = new DependencyVerdictMemo();
const HANDLER_VERDICTS = new WeakMap<object, DependencyVerdictMemo>();

/** The default in-process memo: one per set of CEL handlers an analyzer holds,
 *  since the handlers decide what a verdict says. */
function processMemoFor(analyzer: StaticAnalyzer | undefined): DependencyVerdictMemo {
  const handlers = analyzer?.celHandlers;
  if (!handlers) return PROCESS_VERDICTS;
  let memo = HANDLER_VERDICTS.get(handlers);
  if (!memo) HANDLER_VERDICTS.set(handlers, (memo = new DependencyVerdictMemo()));
  return memo;
}

export interface DependencyAnalysisOptions {
  /** As `AnalysisOptions.hostVersions`. */
  hostVersions?: HostVersions;
  /** The analyzer each library is judged by; a fresh one by default. */
  analyzer?: StaticAnalyzer;
  /** Verdicts kept between processes; none by default. */
  store?: DependencyVerdictStore;
  /** Verdicts kept in process; by default one shared by the process per set of
   *  CEL handlers the analyzer holds. */
  memo?: DependencyVerdictMemo;
  /** The entry's flattened set, when the caller already holds it. */
  entryManifests?: readonly ResourceManifest[];
}

/** One library the application loads, with its verdict. */
export interface DependencyVerdictRecord {
  /** The library's owner source. */
  readonly source: string;
  readonly module: string;
  readonly origin: ModuleOrigin;
  readonly key: string;
  readonly verdict: DependencyVerdict;
  /** The entry's import first reaching the library. */
  readonly reachedThrough?: ReachingImport;
  /** The verdict's findings as the application reports them. */
  readonly diagnostics: readonly AnalysisDiagnostic[];
}

export interface DependencyAnalysis {
  /** Every library's findings as the application reports them, in load order. */
  readonly diagnostics: readonly AnalysisDiagnostic[];
  readonly verdicts: readonly DependencyVerdictRecord[];
}

/**
 * Judge every library `graph` loads — one per module the entry reaches through
 * its reconciled import edges, the entry itself excluded — and report each
 * verdict by the library's origin.
 */
export async function analyzeDependencies(
  graph: LoadedGraph,
  options: DependencyAnalysisOptions = {},
): Promise<DependencyAnalysis> {
  const origins = moduleOrigins(graph);
  const reached = [...reachedModuleSources(graph, graph.rootSource)];
  const libraries = reached.filter((source) => source !== graph.rootSource && libraryDocumentOf(graph, source));
  if (libraries.length === 0) return { diagnostics: [], verdicts: [] };

  const entryManifests = options.entryManifests ?? flattenForAnalyzer(graph);
  const rootModules = new Set(
    entryManifests.filter((m) => isModuleKind(m.kind)).map((m) => m.metadata?.name as string),
  );
  const reach = importReach(entryManifests as ResourceManifest[], rootModules);
  const memo = options.memo ?? processMemoFor(options.analyzer);
  const store = options.store ?? NO_DEPENDENCY_VERDICT_STORE;

  let analyzer = options.analyzer;
  const verdicts: DependencyVerdictRecord[] = [];
  for (const source of libraries) {
    const key = await dependencyVerdictKey(graph, source, options.hostVersions);
    const verdict = await memo.obtain(key, async () => {
      const kept = await store.get(key);
      if (kept?.format === VERDICT_FORMAT) return kept;
      const fresh = judgeLibrary(libraryGraph(graph, source), (analyzer ??= new StaticAnalyzer()), options.hostVersions);
      await store.set(key, fresh);
      return fresh;
    });
    const origin = origins.get(source)!;
    const reachedThrough = reach.of(verdict.module);
    const libraryDoc = libraryDocumentOf(graph, source);
    const imports = importsOfLibrary(graph, reached, source);
    const diagnostics: AnalysisDiagnostic[] = [];
    for (const d of verdict.diagnostics) {
      if (!reachableByImports(d, libraryDoc, imports)) continue;
      if (RULE_EXERCISE_CODES.has(String(d.code))) continue;
      if (origin === "editable") {
        diagnostics.push(d);
        continue;
      }
      if (d.severity !== DiagnosticSeverity.Error) continue;
      // A library no import of the entry reaches is reported where written,
      // rather than lost.
      if (!reachedThrough) {
        diagnostics.push(d);
        continue;
      }
      // The consumer cannot edit a published library: its defects warn.
      diagnostics.push({
        ...importAnchoredDiagnostic(String(d.code), verdict.module, reachedThrough, d.message, writtenPlaceOf(d)),
        severity: DiagnosticSeverity.Warning,
      });
    }
    verdicts.push({
      source,
      module: verdict.module,
      origin,
      key,
      verdict,
      ...(reachedThrough ? { reachedThrough } : {}),
      diagnostics,
    });
  }
  // A library's finding about a library it imports, which that library's own
  // verdict reports as the same defect, is that library's to report.
  const settled = verdicts.map((record) => ({
    ...record,
    diagnostics: withoutCovered(
      record.diagnostics,
      verdicts.flatMap((other) => (other === record ? [] : other.diagnostics)),
    ),
  }));
  return { diagnostics: settled.flatMap((v) => v.diagnostics), verdicts: settled };
}

/**
 * `findings` minus each re-report — a finding carrying `data.writtenAt`, made
 * at an import reaching the module writing its defect — that `coverers` report
 * as the same defect (its code where it is written): by the defect's own
 * finding at least as severely, or by another re-report more severely. A
 * module's own finding is never covered, and two re-reports of one severity
 * both stand.
 */
function withoutCovered(
  findings: readonly AnalysisDiagnostic[],
  coverers: readonly AnalysisDiagnostic[],
): AnalysisDiagnostic[] {
  const own = new Map<string, number>();
  const reported = new Map<string, number>();
  for (const d of coverers) {
    const identity = defectIdentity(d);
    const into = isReReport(d) ? reported : own;
    const known = into.get(identity);
    if (known === undefined || severityRank(d) < known) into.set(identity, severityRank(d));
  }
  return findings.filter((d) => {
    if (!isReReport(d)) return true;
    const identity = defectIdentity(d);
    const byOwn = own.get(identity);
    const byReport = reported.get(identity);
    return !((byOwn !== undefined && byOwn <= severityRank(d)) || (byReport !== undefined && byReport < severityRank(d)));
  });
}

const isReReport = (d: AnalysisDiagnostic): boolean => (d.data as { writtenAt?: unknown } | undefined)?.writtenAt !== undefined;

/** Lower is more severe, as LSP numbers it. */
const severityRank = (d: AnalysisDiagnostic): number => d.severity ?? DiagnosticSeverity.Error;

/**
 * The entry's assembled findings — its load findings and its analysis — minus
 * each one a library's verdict, as folded, reports as the same defect at least
 * as severely: an import-anchored refusal whose `data.writtenAt` is where that
 * library's own check reports it, so each defect is reported once, at the
 * library's lines. An artifact's warning never covers an entry error: that one
 * is a refusal of the entry's own.
 */
export function withoutCoveredDependencyFindings(
  entryDiagnostics: readonly AnalysisDiagnostic[],
  dependencies: DependencyAnalysis,
): AnalysisDiagnostic[] {
  return withoutCovered(entryDiagnostics, dependencies.diagnostics);
}

/**
 * Every library's findings as reported, minus each of an artifact's warnings
 * at an import that the entry reports as the same defect — its own refusal at
 * that import, or a load finding where the defect is written.
 */
export function withoutCoveredArtifactWarnings(
  dependencies: DependencyAnalysis,
  entryDiagnostics: readonly AnalysisDiagnostic[],
): AnalysisDiagnostic[] {
  return dependencies.verdicts.flatMap((v) =>
    v.origin === "artifact" && v.reachedThrough ? withoutCovered(v.diagnostics, entryDiagnostics) : [...v.diagnostics],
  );
}

/** The verdict key of the library at `librarySource`: a digest of every file
 *  its closure holds (by source and text), what the loader stamped on each file
 *  claim, how each of its imports resolved, the child applications it runs, the
 *  host versions and the analyzer version. */
export async function dependencyVerdictKey(
  graph: LoadedGraph,
  librarySource: string,
  hostVersions?: HostVersions,
): Promise<string> {
  const closure = [...reachedModuleSources(graph, librarySource)].sort();
  const files: [string, string][] = [];
  const edges: [string, string, string][] = [];
  const stamps: [string, string, string, string][] = [];
  const children: [string, string, string, string][] = [];
  const addModules = (modules: LoadedGraph["modules"], importEdges: LoadedGraph["importEdges"], scoped: LoadedGraph["scopedImportEdges"]) => {
    for (const mod of modules.values()) {
      for (const file of [mod.owner, ...mod.partials]) {
        files.push([file.source, file.text]);
        for (const manifest of file.manifests) collectFoundStamps(manifest, file.source, "", stamps);
        for (const [alias, edge] of importEdges.get(file.source) ?? []) {
          edges.push([file.source, alias, edge.targetSource]);
        }
        for (const edge of scoped?.get(file.source) ?? []) {
          edges.push([file.source, `${edge.holders.map((h) => h.name).join("/")}/${edge.alias}`, edge.targetSource]);
        }
      }
    }
  };
  addModules(new Map(closure.map((source) => [source, graph.modules.get(source)!])), graph.importEdges, graph.scopedImportEdges);
  const inClosure = new Set(files.map(([source]) => source));
  for (const [file, loads] of graph.moduleApplicationSources ?? []) {
    if (!inClosure.has(file)) continue;
    for (const [source, load] of loads) {
      if ("failure" in load) {
        children.push([file, source, "failed", load.failure.error.message]);
        continue;
      }
      children.push([file, source, "loaded", load.graph.rootSource]);
      addModules(load.graph.modules, load.graph.importEdges, load.graph.scopedImportEdges);
    }
  }
  const host = Object.entries(hostVersions ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const text = JSON.stringify([VERDICT_FORMAT, TELO_RUNNING_SURFACE, host, files, edges, stamps, children]);
  return sha256Base64Url(new TextEncoder().encode(text));
}

/** What the loader stamped on each tagged value of `value`, by path: the entry
 *  its file claim names and the head it read there. */
function collectFoundStamps(
  value: unknown,
  file: string,
  path: string,
  out: [string, string, string, string][],
): void {
  if (isTaggedSentinel(value)) {
    const entry = foundEntryOf(value);
    const head = (value as unknown as Record<string, unknown>)[FOUND_HEAD];
    if (entry !== undefined || typeof head === "string") {
      out.push([file, path, entry ?? "", typeof head === "string" ? head : ""]);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectFoundStamps(item, file, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === "object") {
    for (const [k, child] of Object.entries(value)) collectFoundStamps(child, file, `${path}.${k}`, out);
  }
}

/** Bumped whenever what a verdict holds changes: 3 holds the library's load
 *  findings and every import-anchored finding's `writtenAt`. */
const VERDICT_FORMAT = 3;

/**
 * `graph` re-rooted at the library at `librarySource`, holding only the
 * library's closure — what `telo check <library>` loads, with the import edges
 * as the application's load reconciled them.
 */
export function libraryGraph(graph: LoadedGraph, librarySource: string): LoadedGraph {
  const closure = reachedModuleSources(graph, librarySource);
  const modules = new Map([...graph.modules].filter(([source]) => closure.has(source)));
  const files = new Set<string>();
  for (const mod of modules.values()) {
    for (const file of [mod.owner, ...mod.partials]) files.add(file.source);
  }
  const entry = graph.modules.get(librarySource)!;
  const importEdges = new Map<string, Map<string, ImportEdge>>(
    [...graph.importEdges].filter(([file]) => files.has(file)),
  );
  const scopedImportEdges = new Map<string, ScopedImportEdge[]>(
    [...(graph.scopedImportEdges ?? [])].filter(([file]) => files.has(file)),
  );
  const inClosure = (d: AnalysisDiagnostic) => {
    const file = (d.data as { filePath?: string } | undefined)?.filePath;
    return file !== undefined && files.has(file);
  };
  return {
    rootSource: librarySource,
    entry,
    modules,
    importEdges,
    scopedImportEdges,
    overrides: graph.overrides,
    migrate: graph.migrate,
    // A migration reports only for the entry's own files: here the library's.
    migrationDiagnostics: [entry.owner, ...entry.partials].flatMap((file) => file.migrations.diagnostics),
    versionDiagnostics: graph.versionDiagnostics.filter(inClosure),
    moduleFileDiagnostics: graph.moduleFileDiagnostics.filter(inClosure),
    metadataDiagnostics: metadataStampDiagnostics({ entry, modules, importEdges, scopedImportEdges }),
    parseDiagnostics: graph.parseDiagnostics.filter(inClosure),
    errors: graph.errors.filter((e) => e.fromSource !== null && files.has(e.fromSource)),
    applicationSources: new Map([...(graph.moduleApplicationSources ?? [])].filter(([file]) => files.has(file))),
    // The consuming graph's migrated copies are already in `modules`; the
    // stage is not run again over them.
    ...(graph.libraryMigrations ? { libraryMigrations: graph.libraryMigrations } : {}),
  };
}

/** Whether a rule ran is decided by the instances of the whole application,
 *  which the consumer's own analysis judges; the library alone holds none. */
const RULE_EXERCISE_CODES: ReadonlySet<string> = new Set(["RESOURCE_RULE_UNEXERCISED", "REFERRER_RULE_UNEXERCISED"]);

/** The library's own verdict over its re-rooted graph: its load findings and
 *  its live analysis, as `telo check <library>` reports them. */
function judgeLibrary(graph: LoadedGraph, analyzer: StaticAnalyzer, hostVersions?: HostVersions): DependencyVerdict {
  const { registration, manifests, moduleDocuments, applicationSources } = registerLoadedGraph(
    graph,
    new AnalysisRegistry(),
  );
  const analysis = analyzer.analyzeRegistered(
    manifests,
    { moduleDocuments, positions: collectFilePositions(graph), applicationSources, ...(hostVersions ? { hostVersions } : {}) },
    registration,
  );
  const module = libraryDocumentOf(graph, graph.rootSource)!.metadata!.name as string;
  return {
    format: VERDICT_FORMAT,
    module,
    diagnostics: assembleEntryDiagnostics(graph, analysis).diagnostics,
  };
}
