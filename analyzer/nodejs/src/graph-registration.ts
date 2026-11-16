import type { ResourceManifest } from "@telorun/sdk";
import type { AnalysisRegistry } from "./analysis-registry.js";
import { collectApplicationSources } from "./child-application.js";
import { registerDefinitions, type DefinitionRegistration } from "./definition-registration.js";
import { collectModuleDocuments, declarationPlaneOf, flattenForAnalyzer } from "./flatten-for-analyzer.js";
import { runLibraryMigrationStage, takeLibraryMigrationCopies } from "./library-migrations/stage.js";
import type { LoadedGraph } from "./loaded-types.js";
import type { ModuleDocuments } from "./module-documents.js";

/** A loaded graph ready for {@link StaticAnalyzer.analyzeRegistered}: its
 *  declaration plane registered, then the graph flattened over it. */
export interface RegisteredGraph {
  readonly registration: DefinitionRegistration;
  /** The flattened set, holding the plane's own documents. */
  readonly manifests: ResourceManifest[];
  readonly moduleDocuments: ModuleDocuments[];
  readonly applicationSources: ReturnType<typeof collectApplicationSources>;
}

/**
 * The graph entry point's half before analysis: the declaration plane read off
 * the graph and registered into `registry`, then the graph flattened reusing
 * that plane. Registration runs once here, before flatten, so whatever reads
 * the graph between the two sees the registry every analysis of it will read.
 *
 * Between the two runs the library migration stage, when the closure declares
 * `migrations:`, the graph was loaded migrated and has not run it: the graph takes its own copies of
 * the modules reaching such a library before registration, so the plane shares
 * their trees, and the stage rewrites the copies in place. What the stage
 * rewrote can move the plane — a document's kind, the resource inputs a library
 * declares that its importers' imports stamp — so it is read again.
 */
export function registerLoadedGraph(graph: LoadedGraph, registry: AnalysisRegistry): RegisteredGraph {
  const pending = graph.migrate ? takeLibraryMigrationCopies(graph) : undefined;
  let moduleDocuments = collectModuleDocuments(graph);
  let plane = declarationPlaneOf(graph);
  const registration = registerDefinitions(plane.manifests, registry, moduleDocuments);
  if (pending) {
    graph.libraryMigrations = runLibraryMigrationStage(graph, pending, registry._context().definitions!);
    if (graph.libraryMigrations.rewritten.length > 0) {
      moduleDocuments = collectModuleDocuments(graph);
      plane = declarationPlaneOf(graph);
    }
  }
  return {
    registration,
    manifests: flattenForAnalyzer(graph, plane),
    moduleDocuments,
    applicationSources: collectApplicationSources(graph),
  };
}
