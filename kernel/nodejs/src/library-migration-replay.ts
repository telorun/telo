import {
  applyLibraryMigrationRecord,
  cloneMigrationTree,
  migrationFailureRefusal,
  migrationRecordMismatches,
  type AnalysisDiagnostic,
  type LoadedFile,
  type LoadedGraph,
  type LoadedModule,
  type ModuleMigrationRecord,
} from "@telorun/analyzer";
import { RuntimeError } from "@telorun/sdk";
import { loadRefusalError } from "./static-analysis-diagnostics.js";

/**
 * The library migration stage's edit record, replayed over a compiled load.
 *
 * The stage runs once, over the analysis load of the graph; what it changed in
 * a module source is a record. A compiled load of the same source receives the
 * record on a copy of its trees — never the Loader's cached files, which another
 * graph of the same Loader reads unmigrated — with every compiled value carried
 * by position. The record is refused when a file's text is not the text it was
 * computed from, since its pointers would land on another tree.
 */
export function withLibraryMigrations(
  module: LoadedModule,
  record: ModuleMigrationRecord | undefined,
): LoadedModule {
  if (!record) return module;
  const files = [module.owner, ...module.partials];
  const textOf = new Map(files.map((file) => [file.source, file.text]));
  const changed = migrationRecordMismatches(record, (file) => textOf.get(file));
  if (changed.length > 0) {
    throw new RuntimeError(
      "ERR_MANIFEST_VALIDATION_FAILED",
      `${changed.join(", ")} changed after the load analyzed ${changed.length === 1 ? "it" : "them"}, so the ` +
        `library migrations computed from that text no longer apply. Load the application again.`,
    );
  }
  const copies = new Map<string, LoadedFile>(
    files.map((file) => [
      file.source,
      { ...file, manifests: file.manifests.map((m) => cloneMigrationTree(m) as LoadedFile["manifests"][number]) },
    ]),
  );
  applyLibraryMigrationRecord(record, (file) => copies.get(file)?.manifests as unknown[] | undefined);
  return {
    owner: copies.get(module.owner.source)!,
    partials: module.partials.map((partial) => copies.get(partial.source)!),
  };
}

/** The record `graph`'s stage computed for the module at `source`, if any. */
export function libraryMigrationRecordOf(
  graph: LoadedGraph | undefined,
  source: string,
): ModuleMigrationRecord | undefined {
  return graph?.libraryMigrations?.records.get(source);
}

/**
 * Every `MIGRATION_FAILED` of `graph`, located as `telo check` reports it,
 * raised as `ERR_MIGRATION_FAILED` beside `others` — the analysis's remaining
 * errors — before any resource is created (`migrationFailureRefusal`). Nothing
 * when no migration failed.
 */
export function refuseFailedMigrations(graph: LoadedGraph, others: readonly AnalysisDiagnostic[]): void {
  const refusal = migrationFailureRefusal(graph, others);
  if (refusal) throw loadRefusalError(refusal);
}
