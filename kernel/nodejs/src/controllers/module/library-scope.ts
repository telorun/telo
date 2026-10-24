import {
  AnalysisRegistry,
  DiagnosticSeverity,
  flattenLoadedModule,
  type LoadedModule,
} from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import { RuntimeError } from "@telorun/sdk";
import type { BuiltinControllerContext } from "../../internal-context.js";
import { rootContextOf } from "./shared-libraries.js";

/**
 * LIBRARY SCOPE — what a `Telo.Import` needs before it can normalize and order
 * its library's manifests, per distinct resolved module URL.
 *
 * The scope is the kernel's ONE analysis registry, read through the library's
 * `forModule` view: the load already registered every module's definitions and
 * alias table into it, and Phase-5 injection and contract binding already read
 * each library's scope from it. Normalizing against a second, private registry
 * would model one library's scope twice in one process, and building it cost a
 * whole analysis pass per library.
 *
 * A library the load did not reach (a programmatic load, an import no graph
 * walk saw) is analyzed once through the same view — validated as the pass's
 * own module and added to the shared registry — against its own flattened
 * graph, which also serves as its cross-module targets.
 *
 * Nothing here reads the importer's alias, `variables`, `secrets`, `runtime` or
 * `logging`, so the target and its scope are cached per URL. `normalize()`
 * still runs once per import site: Phase-5 injection mutates the manifests it
 * registers, so two import sites must never share manifest objects.
 *
 * Scoped like `sharedLibraries`: a `WeakMap` keyed on the kernel's root context,
 * so two in-process kernels never share an entry and the cache dies with its
 * kernel.
 */
export interface LibraryScope {
  /** The library's own manifests, compiled — normalized per import site. */
  readonly rawManifests: ResourceManifest[];
  /** The kernel registry as seen from inside the library. */
  readonly registry: AnalysisRegistry;
  /** Other modules' exported instances, for the library's `!ref Alias.name`. */
  readonly crossModuleTargets: ResourceManifest[];
}

interface LibraryEntry {
  target?: Promise<LoadedModule>;
  scope?: Promise<LibraryScope>;
}

const caches = new WeakMap<object, Map<string, LibraryEntry>>();

function libraryEntry(resolvedUrl: string, ctx: BuiltinControllerContext): LibraryEntry {
  const root = rootContextOf(ctx.moduleContext) as unknown as object;
  let cache = caches.get(root);
  if (!cache) caches.set(root, (cache = new Map()));
  let entry = cache.get(resolvedUrl);
  if (!entry) cache.set(resolvedUrl, (entry = {}));
  return entry;
}

/** The import target as the loader reads it, loaded once per URL. A failure is
 *  not cached, so a later import of the URL tries again. */
export function loadLibraryTarget(
  resolvedUrl: string,
  ctx: BuiltinControllerContext,
): Promise<LoadedModule> {
  const entry = libraryEntry(resolvedUrl, ctx);
  if (!entry.target) {
    const pending = ctx.libraryAnalysisHost().loadModule(resolvedUrl, {
      compile: true,
      desugarImports: true,
      migrate: true,
    });
    entry.target = pending;
    pending.catch(() => {
      if (entry.target === pending) entry.target = undefined;
    });
  }
  return entry.target;
}

/** The scope of the library at `resolvedUrl`, an import target already
 *  identified as the library named `module`. */
export function resolveLibraryScope(
  resolvedUrl: string,
  module: string,
  ctx: BuiltinControllerContext,
): Promise<LibraryScope> {
  const entry = libraryEntry(resolvedUrl, ctx);
  if (!entry.scope) {
    const pending = computeLibraryScope(resolvedUrl, module, ctx);
    entry.scope = pending;
    // A validation failure is a hard boot error, not a deferral — but don't
    // let a rejected promise permanently poison the entry for this URL.
    pending.catch(() => {
      if (entry.scope === pending) entry.scope = undefined;
    });
  }
  return entry.scope;
}

async function computeLibraryScope(
  resolvedUrl: string,
  module: string,
  ctx: BuiltinControllerContext,
): Promise<LibraryScope> {
  const host = ctx.libraryAnalysisHost();
  const rawManifests = flattenLoadedModule(await loadLibraryTarget(resolvedUrl, ctx));

  if (module === host.entryModule) {
    return ownRegistryScope(resolvedUrl, ctx, rawManifests);
  }
  const registry = host.registry.forModule(module);
  if (ctx.isImportValidatedAtLoad(resolvedUrl)) {
    return {
      rawManifests,
      registry,
      // The library's own exports are forwarded into the load-time set too; as
      // targets they would turn `!ref <module>.x` into a cross-module reference
      // to the library itself.
      crossModuleTargets: host.loadTimeManifests.filter(
        (m) => (m.metadata as { module?: unknown } | undefined)?.module !== module,
      ),
    };
  }

  const { manifests: graphManifests, moduleDocuments, applicationSources } = await host.loadLibrary(resolvedUrl);
  const errors = host.analyzer
    .analyze(graphManifests, { moduleDocuments, applicationSources }, registry)
    .filter((d) => d.severity === DiagnosticSeverity.Error)
    .map((d) => d.message);
  if (errors.length > 0) {
    throw new RuntimeError("ERR_MANIFEST_VALIDATION_FAILED", errors.join("\n"));
  }
  return { rawManifests, registry, crossModuleTargets: graphManifests };
}

/**
 * A library named like the application it is imported into. The shared registry
 * keys each module's alias table by module name, so the two cannot both have
 * one there: the application's resources would resolve their kinds through the
 * library's imports, find no definition, and get no reference injection. The
 * library is analyzed into a registry of its own instead.
 */
async function ownRegistryScope(
  resolvedUrl: string,
  ctx: BuiltinControllerContext,
  rawManifests: ResourceManifest[],
): Promise<LibraryScope> {
  const host = ctx.libraryAnalysisHost();
  const { manifests: graphManifests, moduleDocuments, applicationSources } = await host.loadLibrary(resolvedUrl);
  const registry = new AnalysisRegistry();
  const errors = host.analyzer
    .analyze(
      graphManifests,
      { skipValidation: ctx.isImportValidatedAtLoad(resolvedUrl), moduleDocuments, applicationSources },
      registry,
    )
    .filter((d) => d.severity === DiagnosticSeverity.Error)
    .map((d) => d.message);
  if (errors.length > 0) {
    throw new RuntimeError("ERR_MANIFEST_VALIDATION_FAILED", errors.join("\n"));
  }
  return { rawManifests, registry, crossModuleTargets: graphManifests };
}
