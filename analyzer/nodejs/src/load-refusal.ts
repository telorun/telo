import { collectFilePositions } from "./diagnostic-location.js";
import { FindingOrder } from "./finding-order.js";
import { importFailureDiagnostics } from "./import-resolution-diagnostics.js";
import { libraryMigrationDiagnostics, withLibraryMigrationsApplied } from "./library-migrations/report.js";
import type { GraphLoadError, LoadedGraph } from "./loaded-types.js";
import { runtimeCodeOf } from "./load-refusal-code.js";
import { METADATA_RESERVED_FIELD } from "./metadata-stamps.js";
import type { NeedTable } from "./need-table.js";
import { describeModuleSource } from "./nested-module-origin.js";
import type { ResourceManifest } from "@telorun/sdk";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import { isNeedTableDiagnostic } from "./validate-needs.js";

/**
 * How a kernel refuses a load, decided from the loaded graph and what its
 * analysis found — the one rule every kernel applies, so a manifest is refused
 * with the same code, message and carried findings whichever kernel loads it.
 * A static code is raised under `runtimeCodeOf`'s answer at every group.
 * Browser-safe: the result is data, and the kernel raises it as its own error.
 */

/** A refusal of a need, raised under its runtime code. */
export interface NeedRefusal {
  runtimeCode: string;
  message: string;
  filePath?: string;
  path: string;
  resource?: { kind: string; name: string };
}

/** One finding a refusal carries: a diagnostic, under `code` when the refusal
 *  raises it under another code than its own, or a need refusal. */
export type CarriedFinding = { diagnostic: AnalysisDiagnostic; code?: string } | { need: NeedRefusal };

export interface LoadRefusal {
  /** The code the refusal is raised under. */
  code: string;
  message: string;
  carried: CarriedFinding[];
}

/** What the rule asks of the kernel between its groups. */
export interface LoadRefusalHost {
  /** Between the parse group and the version conflicts: the module artifacts. */
  buildModuleArtifacts(): void;
  /** After the module-file group: registers the graph and returns its flattened
   *  manifests and the entry's module document. */
  register(): { manifests: readonly ResourceManifest[]; rootModuleDocument: ResourceManifest | undefined };
  /** After the root-module group: the analysis of the registered graph. */
  analyze(): readonly AnalysisDiagnostic[] | Promise<readonly AnalysisDiagnostic[]>;
  /** The need table, asked only when the analysis found no error or a need-table one. */
  needTable(): NeedTable;
}

const MANIFEST_VALIDATION_FAILED = "ERR_MANIFEST_VALIDATION_FAILED";
const MIGRATION_FAILED = "MIGRATION_FAILED";

/**
 * The refusal of a load of `graph` from `entryUrl`, or `undefined` when it
 * loads, by the first group that refuses, in order: (1) the import failures;
 * (2) the parse and coded loader findings; the module artifacts are built;
 * (3) the version conflicts; (4) the module-file findings; (5) an entry that is
 * a library; the analysis runs; a failed library migration; (6) the metadata
 * stamps; (7) the need table's refusals; each of the last three beside every
 * other error the analysis found; (8) the analysis's errors.
 */
export async function loadRefusal(
  graph: LoadedGraph,
  entryUrl: string,
  host: LoadRefusalHost,
): Promise<LoadRefusal | undefined> {
  if (graph.errors.length > 0) return importFailureRefusal(graph.errors, graph.entry.owner.source);
  // A YAML parse failure yields a mangled tree: fatal before any controller sees it.
  if (graph.parseDiagnostics.length > 0) return fileFindingsRefusal(graph, graph.parseDiagnostics);
  host.buildModuleArtifacts();
  // A same-major hoist is advisory; an incompatible major would silently run the wrong one.
  const conflicts = graph.versionDiagnostics.filter((d) => d.code === "MODULE_VERSION_CONFLICT");
  if (conflicts.length > 0) {
    return {
      code: MANIFEST_VALIDATION_FAILED,
      message: conflicts.map((d) => d.message).join("\n"),
      carried: conflicts.map((diagnostic) => ({ diagnostic })),
    };
  }
  if (graph.moduleFileDiagnostics.length > 0) return fileFindingsRefusal(graph, graph.moduleFileDiagnostics);
  const { manifests, rootModuleDocument } = host.register();
  if (rootModuleDocument?.kind === "Telo.Library") {
    return {
      code: MANIFEST_VALIDATION_FAILED,
      message: `Root manifest '${entryUrl}' is a Telo.Library. Only Telo.Application manifests can be run directly — libraries are imported via Telo.Import.`,
      carried: [],
    };
  }
  // A node a library migration failed on is left as written: the findings
  // beneath it are held back, as `telo check` holds them back.
  const errors = withLibraryMigrationsApplied(graph, await host.analyze()).filter(
    (d) => d.severity === DiagnosticSeverity.Error,
  );
  const migrationRefusal = migrationFailureRefusal(graph, errors);
  if (migrationRefusal) return migrationRefusal;
  const stamps = [...graph.metadataDiagnostics, ...errors.filter((d) => d.code === METADATA_RESERVED_FIELD)];
  if (stamps.length > 0) {
    const sorted = new FindingOrder(manifests, collectFilePositions(graph)).sort(stamps);
    return {
      code: runtimeCodeOf(METADATA_RESERVED_FIELD),
      message: sorted.map((d) => `${located(graph, d)}${d.message}`).join("\n"),
      carried: [
        ...sorted.map((diagnostic) => ({ diagnostic, code: runtimeCodeOf(String(diagnostic.code)) })),
        ...errors.filter((d) => d.code !== METADATA_RESERVED_FIELD).map((diagnostic) => ({ diagnostic })),
      ],
    };
  }
  // A load refused for a need-table problem reports its twins beside every other
  // error, rather than the analysis's aggregate.
  const analysed = errors.filter(isNeedTableDiagnostic);
  if (errors.length === 0 || analysed.length > 0) {
    const refusals = needTableRefusals(host.needTable(), analysed);
    if (refusals.length > 0) {
      return needRefusal(
        refusals,
        errors.filter((d) => !isNeedTableDiagnostic(d)),
      );
    }
  }
  if (errors.length > 0) {
    return {
      code: MANIFEST_VALIDATION_FAILED,
      message: "Manifest validation failed",
      carried: errors.map((diagnostic) => ({ diagnostic })),
    };
  }
  return undefined;
}

/**
 * The refusal of import failures: one error carrying every import's diagnostic
 * as `telo check` reports it, headed by the first failure's own message. Its
 * code is the first failure's own runtime code when its error carries one —
 * a transport's refusal is never masked — else the twin of that diagnostic's
 * code. Also what an import no load walked is refused with; `entrySource` is
 * the file a failure with no `fromSource` is reported against.
 */
export function importFailureRefusal(errors: readonly GraphLoadError[], entrySource: string): LoadRefusal {
  const [first] = errors;
  if (!first) throw new Error("importFailureRefusal called with no import failure");
  const diagnostics = importFailureDiagnostics(errors, entrySource);
  const own = (first.error as { code?: unknown }).code;
  return {
    code: typeof own === "string" && own.startsWith("ERR_") ? own : runtimeCodeOf(String(diagnostics[0]!.code)),
    message: first.error.message,
    carried: diagnostics.map((diagnostic) => ({ diagnostic })),
  };
}

/** Every `MIGRATION_FAILED` of `graph`, raised as `ERR_MIGRATION_FAILED` beside
 *  `others`; `undefined` when no migration failed. */
export function migrationFailureRefusal(
  graph: LoadedGraph,
  others: readonly AnalysisDiagnostic[],
): LoadRefusal | undefined {
  const failed = libraryMigrationDiagnostics(graph).filter((d) => d.code === MIGRATION_FAILED);
  if (failed.length === 0) return undefined;
  const code = runtimeCodeOf(MIGRATION_FAILED);
  const carried: CarriedFinding[] = [
    ...failed.map((diagnostic) => ({ diagnostic, code })),
    ...others.map((diagnostic) => ({ diagnostic })),
  ];
  return { code, message: carried.map(codedLine).join("\n"), carried };
}

/** Need refusals raised together with `others`, each line naming its own code —
 *  the refusal's code is only the first's. */
export function needRefusal(refusals: readonly NeedRefusal[], others: readonly AnalysisDiagnostic[]): LoadRefusal {
  const [first] = refusals;
  if (!first) throw new Error("needRefusal called with no refusal");
  const carried: CarriedFinding[] = [
    ...refusals.map((need) => ({ need })),
    ...others.map((diagnostic) => ({ diagnostic })),
  ];
  return { code: first.runtimeCode, message: carried.map(codedLine).join("\n"), carried };
}

/** The table's own problems, then each need-table refusal the analysis made in
 *  some configurations only — one standing where a choice expands, which the
 *  graph's documents hold unexpanded — raised as its twin. */
function needTableRefusals(table: NeedTable, analysed: readonly AnalysisDiagnostic[]): NeedRefusal[] {
  const refusals: NeedRefusal[] = [...table.problems];
  for (const d of analysed) {
    const data = d.data as
      | { filePath?: string; path?: string; resource?: { kind: string; name: string }; configurations?: unknown }
      | undefined;
    if (!data?.configurations || d.code === undefined) continue;
    if (table.problems.some((p) => p.code === d.code && p.path === data.path && p.filePath === data.filePath)) continue;
    refusals.push({
      runtimeCode: runtimeCodeOf(String(d.code)),
      message: d.message,
      path: data.path ?? "",
      ...(data.filePath !== undefined ? { filePath: data.filePath } : {}),
      ...(data.resource ? { resource: data.resource } : {}),
    });
  }
  return refusals;
}

/** Findings that each name their file, refused as one validation failure. */
function fileFindingsRefusal(graph: LoadedGraph, diagnostics: readonly AnalysisDiagnostic[]): LoadRefusal {
  return {
    code: MANIFEST_VALIDATION_FAILED,
    message: diagnostics.map((d) => `${located(graph, d)}${d.message}`).join("\n"),
    carried: diagnostics.map((diagnostic) => ({ diagnostic })),
  };
}

/** `<module source>: ` for a diagnostic naming its file, else nothing. */
function located(graph: LoadedGraph, d: AnalysisDiagnostic): string {
  const filePath = (d.data as { filePath?: string } | undefined)?.filePath;
  return filePath ? `${describeModuleSource(graph, filePath)}: ` : "";
}

/** `<file>: <message> (<code>)`, each part present when the finding has it. */
function codedLine(finding: CarriedFinding): string {
  if ("need" in finding) {
    const { need } = finding;
    return `${need.filePath ? `${need.filePath}: ` : ""}${need.message} (${need.runtimeCode})`;
  }
  const { diagnostic } = finding;
  const filePath = (diagnostic.data as { filePath?: string } | undefined)?.filePath;
  const code = finding.code ?? (diagnostic.code !== undefined ? String(diagnostic.code) : undefined);
  return `${filePath ? `${filePath}: ` : ""}${diagnostic.message}${code ? ` (${code})` : ""}`;
}
