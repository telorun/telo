import type {
  LoadedGraph,
  AnalysisRegistry,
  ApplicationSourceRecords,
  LoadedModule,
  ModuleDocuments,
  StaticAnalyzer,
} from "@telorun/analyzer";
import type { LoadOptions, ResourceContext, ResourceManifest } from "@telorun/sdk";
import type { ScopeConfig } from "./logging/scope-config.js";
import type { EvaluationContext } from "./evaluation-context.js";
import type { ModuleContext } from "./module-context.js";

/** The kernel's analysis state an import reads its library's scope from. */
export interface LibraryAnalysisHost {
  analyzer: StaticAnalyzer;
  /** The kernel's one analysis registry; a library is read through its
   *  `forModule` view. */
  registry: AnalysisRegistry;
  /** The load-time flattened set: every library's forwarded exports, the
   *  cross-module targets a library's `!ref Alias.name` resolves against. */
  loadTimeManifests: ResourceManifest[];
  /** The load-time flattened set as written, before this configuration's
   *  expansion: every library document's choices still in it. */
  loadTimeDocuments: ResourceManifest[];
  /** The root Application's `metadata.name`. */
  entryModule: string | undefined;
  /** The graph the load read, whose scoped imports a library's own reading
   *  is stamped from. */
  loadedGraph: LoadedGraph | undefined;
  /** An import target as the loader read it — what the import's identity is
   *  judged on — with its expressions adopted like any loaded module's. */
  loadModule(url: string, options?: LoadOptions): Promise<LoadedModule>;
  /** A library's flattened analysis set, the full documents of every library
   *  it imports — what its analysis resolves a projection hop into another
   *  library's internals against — and the child applications its resources run. */
  loadLibrary(url: string): Promise<{
    manifests: ResourceManifest[];
    moduleDocuments: ModuleDocuments[];
    applicationSources: ApplicationSourceRecords;
  }>;
}

/**
 * Context interface used by built-in kernel controllers (Telo.Application /
 * Telo.Library / Telo.Import / Telo.Definition / Telo.Abstract) that need
 * privileged access to load-time graph identity. These methods are
 * intentionally *not* on the public `ResourceContext` exposed to module
 * authors — they couple the caller to the kernel's load-time view of the
 * world, and the import-controller is the only consumer today.
 *
 * `ResourceContextImpl` in this package implements both interfaces, so a
 * controller authored against this type still works under the generic
 * `controller.create(resource, ctx)` dispatch — the kernel just types it
 * locally as `BuiltinControllerContext` instead of `ResourceContext`.
 */
export interface BuiltinControllerContext extends ResourceContext {
  /** True when `url` resolved (via the loader's URL → canonical-source
   *  map) to a module that was part of the entry graph successfully
   *  analyzed during `Kernel.load()`. */
  isImportValidatedAtLoad(url: string): boolean;
  libraryAnalysisHost(): LibraryAnalysisHost;
  /** Resolve `importSource` against `fromSource` through the loader's
   *  source-chain `resolveRelative`. Identical to what `loadGraph` used
   *  internally — so the produced URL agrees with the loader's caches. */
  resolveImportUrl(fromSource: string, importSource: string): Promise<string>;
  /** The root Application's resolved logging configuration — the base an
   *  import's own `logging:` block cascades over (§12.2). */
  kernelLoggingRootScope(): ScopeConfig;
  /** The scope run owning the resource, when it is declared in one — where a
   *  scoped `Telo.Import` registers its exports. */
  scopeRunContext(): EvaluationContext | undefined;
  /** Index the library instance a scoped `Telo.Import` built, for this scope
   *  run; the inverse withdraws it. */
  indexScopedLibrary(library: ModuleContext, scope: { alias: string; holder: string; field: string }): () => void;
  /** Rebuild the application's co-referrer index once a `shared` library a
   *  scoped import instantiated has initialized. */
  reindexCoReferrers(): void;
}
