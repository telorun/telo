import { AnalysisRegistry, DiagnosticSeverity } from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import { RuntimeError, type EvaluationContext as IEvaluationContext } from "@telorun/sdk";
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
 * `logging`, so it is cached per URL. `normalize()` still runs once per import
 * site: Phase-5 injection mutates the manifests it registers, so two import
 * sites must never share manifest objects.
 *
 * Scoped like `sharedLibraries`: a `WeakMap` keyed on the kernel's root context,
 * so two in-process kernels never share an entry and the cache dies with its
 * kernel.
 */
export interface LibraryScope {
  /** The library's own manifests, compiled — normalized per import site. */
  readonly rawManifests: ResourceManifest[];
  /** The `Telo.Library` doc's name, undefined when the target declares none. */
  readonly module: string | undefined;
  /** The kernel registry as seen from inside the library. */
  readonly registry: AnalysisRegistry | undefined;
  /** Other modules' exported instances, for the library's `!ref Alias.name`. */
  readonly crossModuleTargets: ResourceManifest[];
}

const caches = new WeakMap<object, Map<string, Promise<LibraryScope>>>();

function libraryScopeCache(ctx: IEvaluationContext): Map<string, Promise<LibraryScope>> {
  const root = rootContextOf(ctx) as unknown as object;
  let cache = caches.get(root);
  if (!cache) caches.set(root, (cache = new Map()));
  return cache;
}

export function resolveLibraryScope(
  resolvedUrl: string,
  ctx: BuiltinControllerContext,
): Promise<LibraryScope> {
  const cache = libraryScopeCache(ctx.moduleContext);
  let pending = cache.get(resolvedUrl);
  if (!pending) {
    pending = computeLibraryScope(resolvedUrl, ctx);
    cache.set(resolvedUrl, pending);
    // A validation failure is a hard boot error, not a deferral — but don't
    // let a rejected promise permanently poison the entry for this URL.
    pending.catch(() => cache.delete(resolvedUrl));
  }
  return pending;
}

async function computeLibraryScope(
  resolvedUrl: string,
  ctx: BuiltinControllerContext,
): Promise<LibraryScope> {
  const rawManifests = await ctx.loadModule(resolvedUrl, {
    compile: true,
    desugarImports: true,
    migrate: true,
  });
  const libraryDoc = rawManifests.find((m) => m.kind === "Telo.Library");
  const module = libraryDoc?.metadata?.name as string | undefined;
  if (!module) return { rawManifests, module, registry: undefined, crossModuleTargets: [] };

  const host = ctx.libraryAnalysisHost();
  if (module === host.entryModule) return ownRegistryScope(resolvedUrl, ctx, rawManifests, module);
  const registry = host.registry.forModule(module);
  if (ctx.isImportValidatedAtLoad(resolvedUrl)) {
    return {
      rawManifests,
      module,
      registry,
      // The library's own exports are forwarded into the load-time set too; as
      // targets they would turn `!ref <module>.x` into a cross-module reference
      // to the library itself.
      crossModuleTargets: host.loadTimeManifests.filter(
        (m) => (m.metadata as { module?: unknown } | undefined)?.module !== module,
      ),
    };
  }

  const graphManifests = await ctx.loadManifests(resolvedUrl);
  const errors = host.analyzer
    .analyze(graphManifests, undefined, registry)
    .filter((d) => d.severity === DiagnosticSeverity.Error)
    .map((d) => d.message);
  if (errors.length > 0) {
    throw new RuntimeError("ERR_MANIFEST_VALIDATION_FAILED", errors.join("\n"));
  }
  return { rawManifests, module, registry, crossModuleTargets: graphManifests };
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
  module: string,
): Promise<LibraryScope> {
  const graphManifests = await ctx.loadManifests(resolvedUrl);
  const registry = new AnalysisRegistry();
  const errors = ctx
    .libraryAnalysisHost()
    .analyzer.analyze(
      graphManifests,
      { skipValidation: ctx.isImportValidatedAtLoad(resolvedUrl) },
      registry,
    )
    .filter((d) => d.severity === DiagnosticSeverity.Error)
    .map((d) => d.message);
  if (errors.length > 0) {
    throw new RuntimeError("ERR_MANIFEST_VALIDATION_FAILED", errors.join("\n"));
  }
  return { rawManifests, module, registry, crossModuleTargets: graphManifests };
}
