import {
  AnalysisRegistry,
  defaultSources,
  flattenForAnalyzer,
  flattenLoadedModule,
  isModuleKind,
  Loader,
  StaticAnalyzer,
  type LoadedGraph,
  type ManifestSource,
} from "@telorun/analyzer";
import {
  ControllerContext,
  ControllerPolicy,
  createCancellationSource,
  Kernel as IKernel,
  ResourceContext,
  ResourceDefinition,
  ResourceInstance,
  ResourceManifest,
  RuntimeError,
  RuntimeEvent,
  type BootTarget,
  type CancellationSource,
  type EvaluationContext as IEvaluationContext,
  type InvokeOptions,
  type ModuleContext as IModuleContext,
  type LoadOptions,
  type ParsedArgs,
} from "@telorun/sdk";
import { parseArgs } from "util";
import { ControllerRegistry } from "./controller-registry.js";
import { EventBus } from "./events.js";
import { KernelTracer } from "./tracing.js";
import { ModuleContext } from "./module-context.js";
import { ResourceContextImpl } from "./resource-context.js";
import { nodeCelHandlers } from "./cel-handlers.js";
import { parseRef, seedInvokeSource } from "./invoke-dispatch.js";
import { buildEvalPaths } from "./eval-paths.js";
import { stripCompiledValues } from "./schema-compiled-values.js";
import { injectAtPath } from "./dependency-injection.js";
import {
  computeAnalysisSignature,
  readAnalysisStamp,
  writeAnalysisStamp,
} from "./manifest-sources/analysis-stamp.js";
import {
  resolveCacheRoot,
} from "./manifest-sources/local-manifest-cache-source.js";
import {
  precompileApplicationEnvSchemas,
  precompileDefinitionSchemas,
  resolveApplicationEnv,
} from "./application-env.js";
import { policyFingerprint } from "./runtime-registry.js";
import { SchemaValidator } from "./schema-validator.js";

/** Walks up the EvaluationContext parent chain to the nearest enclosing
 *  ModuleContext and returns its controller policy (or undefined). Used to
 *  pick the right cache entry when a kind has been loaded under multiple
 *  runtime selections. */
function findEnclosingModule(ctx: IEvaluationContext): ModuleContext | undefined {
  let cur: IEvaluationContext | undefined = ctx;
  while (cur) {
    if (cur instanceof ModuleContext) return cur;
    cur = cur.parent;
  }
  return undefined;
}

function findEnclosingPolicy(ctx: IEvaluationContext): ControllerPolicy | undefined {
  return findEnclosingModule(ctx)?.getControllerPolicy();
}

function throwInvalidState(operation: string, reason: string): never {
  throw new RuntimeError(
    "ERR_KERNEL_STATE_INVALID",
    `Cannot ${operation}(): ${reason}`,
  );
}

export interface KernelOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
  argv?: string[];
  /** Manifest sources the kernel uses to resolve URLs passed to `load()`.
   *  Required: pass an explicit list (`[]` is allowed but means every URL
   *  fails to dispatch). Order matters — later entries take priority over
   *  earlier ones (sources are unshifted onto the dispatch chain). */
  sources: ManifestSource[];
  /** Base URL for the registry source. When unset, the `RegistrySource`
   *  default applies. Callers (e.g. the CLI) are responsible for resolving
   *  `TELO_REGISTRY_URL` or any other env-based fallback before passing. */
  registryUrl?: string;
}

/**
 * Kernel: Central orchestrator managing lifecycle and message bus
 * Handles resource loading, initialization, and execution through controllers
 */
export class Kernel implements IKernel {
  private readonly loader: Loader;
  private readonly analyzer = new StaticAnalyzer({ celHandlers: nodeCelHandlers });
  private readonly registry = new AnalysisRegistry();
  private controllers: ControllerRegistry = new ControllerRegistry();
  private eventBus: EventBus = new EventBus();
  private readonly tracer = new KernelTracer();

  private holdCount = 0;
  private idleResolvers: Array<() => void> = [];
  private _exitCode = 0;
  private readonly sharedSchemaValidator = new SchemaValidator();
  private rootContext!: ModuleContext;
  private staticManifests: ResourceManifest[] = [];
  private _entryUrl?: string;
  /** Root Application `ports:` resolved in `load()` — integer + declared protocol
   *  per name. Surfaced via {@link getResolvedPorts} so a host can advertise where
   *  the running app is reachable. */
  private _resolvedPorts: Array<{ name: string; port: number; protocol: "tcp" | "udp" }> = [];
  /** The `.telo` cache root for this load, resolved once in `load()` and
   *  threaded to the validator, analysis stamp, and npm install root. */
  private _cacheRoot?: string | null;
  private _loadedGraph?: LoadedGraph;
  // Lifecycle state — guards boot/runTargets/teardown/invoke transitions.
  // teardown() is the only idempotent method; everything else throws on misuse.
  private _bootCalled = false;
  private _isBooted = false;
  private _targetsRan = false;
  private _isTornDown = false;
  // Cancellation scope for the boot `targets` run. Created lazily so an early
  // SIGINT (before runTargets) still has a source to cancel, which the run then
  // observes via the pre-dispatch gate.
  private _bootCancellation?: CancellationSource;
  // Root application name — labels the boot `targets` trace span so the app
  // appears as the trace root with its targets nested beneath.
  private _appName?: string;

  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env: Record<string, string | undefined>;
  readonly argv: string[];
  readonly registryUrl: string | undefined;

  constructor(options: KernelOptions) {
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.env = options.env ?? process.env;
    this.argv = options.argv ?? [];
    this.registryUrl = options.registryUrl;
    this.loader = new Loader(defaultSources(this.registryUrl), { celHandlers: nodeCelHandlers });
    for (const source of options.sources) {
      this.loader.register(source);
    }
  }

  async registerController(
    moduleName: string,
    kindName: string,
    controllerInstance: any,
    fingerprint?: string,
  ): Promise<void> {
    this.controllers.registerController(
      `${moduleName}.${kindName}`,
      controllerInstance,
      fingerprint,
    );
    await controllerInstance.register?.(this.createControllerContext(`${moduleName}.${kindName}`));
  }

  /**
   * Register a deferred controller. The definition is already registered; the
   * controller module is imported (and `register()` fired, via the `load` thunk
   * calling back into `registerController`) only on the kind's first
   * instantiation — see `_createInstance` / `ControllerRegistry.takeLazyController`.
   */
  registerLazyController(
    moduleName: string,
    kindName: string,
    fingerprint: string,
    load: () => Promise<void>,
  ): void {
    this.controllers.registerLazyController(`${moduleName}.${kindName}`, fingerprint, load);
  }

  /**
   * Register a resource definition with the controller registry
   */
  registerResourceDefinition(definition: ResourceDefinition): void {
    this.controllers.registerDefinition(definition);
    this.registry.registerDefinition(definition);
  }

  async loadModule(url: string, options?: LoadOptions): Promise<ResourceManifest[]> {
    const lm = await this.loader.loadModule(url, options);
    return flattenLoadedModule(lm);
  }

  async loadManifests(url: string): Promise<ResourceManifest[]> {
    const graph = await this.loader.loadGraph(url, { desugarImports: true });
    if (graph.errors.length > 0) throw graph.errors[0].error;
    return flattenForAnalyzer(graph);
  }

  /** Returns the live analysis registry backed by this kernel's known definitions and aliases.
   *  Pass to StaticAnalyzer.analyze() for incremental validation of new manifests against
   *  already-registered types (e.g. front-end editor validating a manifest before submitting). */
  getAnalysisRegistry(): AnalysisRegistry {
    return this.registry;
  }

  /** The full LoadedGraph captured during `load()`. Used by the CLI to
   *  feed `writeManifestCache` so a successful `telo run` populates
   *  `<entry-dir>/.telo/manifests/` for subsequent runs — the same on-disk
   *  layout `telo install` writes. Undefined before `load()` has been
   *  called or if it threw before the graph was captured. */
  getLoadedGraph(): LoadedGraph | undefined {
    return this._loadedGraph;
  }

  /** True when `url` resolves (via the loader's URL → canonical-source map)
   *  to a module that was already part of the entry graph successfully
   *  analyzed during `load()`. The import-controller uses it to skip its
   *  per-import `analyze()` pass when the kernel's load-time validation
   *  already covered the same subtree. */
  isImportValidatedAtLoad(url: string): boolean {
    if (!this._loadedGraph) return false;
    const canonical = this.loader.canonicalize(url);
    if (!canonical) return false;
    return this._loadedGraph.modules.has(canonical);
  }

  /** Resolve a `Telo.Import.source` against the importing file's URL
   *  through the same source-chain `resolveRelative` the loader used at
   *  graph-walk time. The import-controller routes through here so its
   *  `resolveImportSource` no longer second-guesses the loader for
   *  custom `ManifestSource`s — `isImportValidatedAtLoad` etc. only hit
   *  when both sides agree on the canonical URL. */
  resolveImportUrl(fromSource: string, importSource: string): string {
    const resolved = this.loader.resolveImportUrl(fromSource, importSource);
    // Apply version-reconciliation overrides captured during `load()`: when the
    // entry graph hoisted this module identity to a higher version, redirect the
    // import-controller's independent re-resolution onto the winning source so a
    // sub-library importing a lower version loads the same controller/definition
    // the analyzer registered — never a second, colliding copy. Keyed by
    // canonical URL; `canonicalize` maps a registry ref (returned verbatim by
    // the loader) to the URL the graph walk already resolved it to.
    const overrides = this._loadedGraph?.overrides;
    if (overrides && overrides.size > 0) {
      const canonical = this.loader.canonicalize(resolved) ?? resolved;
      const winner = overrides.get(canonical);
      if (winner) return winner;
    }
    return resolved;
  }

  /**
   * Load built-in Runtime definitions (e.g., Telo.Application, Telo.Library).
   * Also declares all known module namespaces upfront so that resources can be
   * registered to them. User-defined modules are declared explicitly by
   * Telo.Application or Telo.Library resources during the initialization phase.
   */
  private async loadBuiltinDefinitions(): Promise<void> {
    // Declare built-in module namespaces upfront so getContext() can distinguish
    // "not yet populated" from a completely unknown module name.
    this.rootContext.registerImport("Telo", "Telo", []); // built-ins, unrestricted

    // Register built-in definitions with the controller registry.
    // AnalysisRegistry's underlying DefinitionRegistry already seeds KERNEL_BUILTINS on construction.
    for (const def of this.registry.builtinDefinitions()) this.controllers.registerDefinition(def);

    this.controllers.registerController(
      "Telo.Definition",
      await import("./controllers/resource-definition/resource-definition-controller.js"),
    );
    this.controllers.registerController(
      "Telo.Abstract",
      await import("./controllers/resource-definition/abstract-controller.js"),
    );
    const moduleController = await import("./controllers/module/module-controller.js");
    this.controllers.registerController("Telo.Application", moduleController);
    this.controllers.registerController("Telo.Library", moduleController);
    this.controllers.registerController(
      "Telo.Import",
      await import("./controllers/module/import-controller.js"),
    );
  }

  /**
   * Load a manifest by URL. The URL is dispatched through the registered
   * `ManifestSource` chain (file://, http://, pkg:, memory://, …); URL-shape
   * normalization is each source's responsibility.
   *
   * `analyzeOnly` runs the static-analysis pre-flight and persists its
   * caches (the `.validated.json` analysis stamp and the compiled
   * `__validators/` schema cache) but stops before module instantiation,
   * target wiring, and application-env/secret resolution. Build steps
   * (`telo install`) use it to bake those caches into a prebuilt image on a
   * writable filesystem, so the runtime `load()` — which runs on a read-only
   * session rootfs — hits the stamp and skips the validation walk entirely
   * instead of failing to write the caches on every boot.
   */
  async load(
    url: string,
    options?: { analyzeOnly?: boolean; cacheDir?: string | null; writeCache?: boolean },
  ): Promise<void> {
    const sourceUrl = await this.loader.resolveEntryPoint(url);
    this._entryUrl = sourceUrl;
    // Resolve the `.telo` cache root ONCE and thread it to every consumer
    // (validators, analysis stamp, npm install root) — no consumer re-derives
    // it or reads the env independently. A caller (the CLI) may pass `cacheDir`
    // so the env is read exactly once per invocation; otherwise resolve here.
    const cacheRoot =
      options?.cacheDir !== undefined ? options.cacheDir : resolveCacheRoot(sourceUrl);
    this._cacheRoot = cacheRoot;
    const manifestsDir = cacheRoot ? `${cacheRoot}/manifests` : undefined;
    // `writeCache: false` (`telo run --no-cache-write`) keeps the cache
    // READ-only: compiled validators and the analysis stamp are still loaded
    // from disk, but never written back — so an ephemeral, read-only session
    // rootfs validates in-memory without touching the baked cache.
    const writeCache = options?.writeCache !== false;
    // Point the shared schema validator at the cache so compiled AJV validators
    // are loaded (and, when writable, persisted) under
    // `<cache-root>/manifests/__validators/`. Memory-/HTTP-rooted entries skip
    // the cache; their schema compiles stay in-process only.
    this.sharedSchemaValidator.setCacheDir(
      manifestsDir ? `${manifestsDir}/__validators` : undefined,
      { write: writeCache },
    );
    this.rootContext = new ModuleContext(
      sourceUrl,
      {},
      {},
      {},
      [],
      this._createInstance.bind(this),
      (event, payload, metadata) => this.eventBus.emit(event, payload, metadata),
      this.env,
    );
    this.rootContext.tracer = this.tracer;
    // Initialize built-in Runtime definitions first
    await this.loadBuiltinDefinitions();

    // Phase 5: attach injection hook — fires between create() and init() for every resource
    this.rootContext.preInitHook = (resource, getInstance, isPending) =>
      this._injectDependencies(resource, getInstance, isPending);

    // Expose definition lookup so invoke()/invokeResolved() can check thrown
    // InvokeError.code against the declared throw union (rule 9). Propagates
    // through spawnChild() to module imports and scoped handles.
    this.rootContext.getDefinition = (kind) => this.controllers.getDefinition(kind);

    // Static analysis pre-flight: validates schemas and invocation context compatibility.
    // All errors are fatal — kernel does not start if analysis fails.
    // `desugarImports` expands each module's inline `imports:` map into synthetic
    // Telo.Import manifests before discovery walks the graph, so inline imports
    // resolve identically to authored Telo.Import docs.
    const analysisGraph = await this.loader.loadGraph(sourceUrl, { desugarImports: true });
    if (analysisGraph.errors.length > 0) {
      throw analysisGraph.errors[0].error;
    }
    this._loadedGraph = analysisGraph;
    // Version reconciliation: an incompatible major mismatch is fatal (the
    // hoist override would silently run the wrong major); a same-major hoist is
    // advisory — the override already redirects every importer to the winner.
    const versionConflicts = analysisGraph.versionDiagnostics.filter(
      (d) => d.code === "MODULE_VERSION_CONFLICT",
    );
    if (versionConflicts.length > 0) {
      throw new RuntimeError(
        "ERR_MANIFEST_VALIDATION_FAILED",
        versionConflicts.map((d) => d.message).join("\n"),
      );
    }
    for (const d of analysisGraph.versionDiagnostics) {
      if (d.code === "MODULE_VERSION_HOISTED") console.warn(`warning: ${d.message}`);
    }
    const staticManifests = flattenForAnalyzer(analysisGraph);
    this.staticManifests = staticManifests;

    // Register module identities for x-telo-ref resolution (Phase 3 prerequisite).
    // Telo built-ins ("telo" → "Telo") are auto-registered when Telo.Abstract
    // definitions are registered in loadBuiltinDefinitions() above.
    const rootModuleDoc = staticManifests.find((m) => isModuleKind(m.kind));
    if (rootModuleDoc?.kind === "Telo.Library") {
      throw new RuntimeError(
        "ERR_MANIFEST_VALIDATION_FAILED",
        `Root manifest '${sourceUrl}' is a Telo.Library. Only Telo.Application manifests can be run directly — libraries are imported via Telo.Import.`,
      );
    }
    for (const m of staticManifests) {
      if (isModuleKind(m.kind) && m.metadata?.name && m.metadata?.namespace) {
        this.registry.registerModuleIdentity(
          m.metadata.namespace as string,
          m.metadata.name as string,
        );
      }
    }

    // Hash-keyed analysis cache: when the entry's full LoadedGraph matches
    // a previously-stamped successful run (same file bytes, same stamp
    // protocol version), skip the per-resource validation walk inside
    // `analyzeErrors`. Registration of identities / aliases / definitions
    // and inline-resource normalisation still runs — only the diagnostic
    // passes are elided. Memory- / HTTP-rooted entries have no
    // local stamp store and always re-validate.
    const analysisSignature = computeAnalysisSignature(analysisGraph);
    const stamp = manifestsDir
      ? await readAnalysisStamp("", manifestsDir)
      : undefined;
    const skipValidation = stamp?.signature === analysisSignature;
    const errors = this.analyzer.analyzeErrors(
      staticManifests,
      { skipValidation },
      this.registry,
    );
    if (errors.length > 0) {
      throw new RuntimeError(
        "ERR_MANIFEST_VALIDATION_FAILED",
        "Manifest validation failed",
        errors.map((d) => ({
          severity: "error" as const,
          message: d.message,
          code: d.code !== undefined ? String(d.code) : undefined,
          resource: (d.data as any)?.resource
            ? `${(d.data as any).resource.kind}.${(d.data as any).resource.name}`
            : undefined,
        })),
      );
    }
    if (manifestsDir && writeCache && !skipValidation) {
      // Best-effort: stamp the verdict so subsequent loads hit the fast
      // path. A read-only filesystem (baked Docker image) reports the
      // failure on stderr and keeps running — the lookup above will
      // simply miss next time. Skipped under `--no-cache-write`.
      try {
        await writeAnalysisStamp("", analysisSignature, manifestsDir);
      } catch (err) {
        this.stderr.write(
          `[telo:kernel] analysis stamp write failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    // Build-time warm pass: the analysis caches are now on disk. Also bake the
    // application-env residual validators — the runtime `resolveApplicationEnv`
    // (below) compiles these on EVERY boot regardless of the stamp, so without
    // pre-compiling them here an app with `variables`/`secrets`/`ports` would
    // still hit the read-only `__validators` write on a baked image. Then stop
    // before module instantiation / target wiring / application-env value
    // resolution — those need a running environment (e.g. session secrets) the
    // build does not have, and the runtime `load()` performs them anyway.
    if (options?.analyzeOnly) {
      if (rootModuleDoc?.kind === "Telo.Application") {
        precompileApplicationEnvSchemas(
          rootModuleDoc as Record<string, any>,
          this.sharedSchemaValidator,
        );
      }
      // Bake the per-kind resource-config validators too. `_createInstance`
      // compiles `controller.schema` (which falls back to the definition's own
      // `schema`) for every resource at runtime — work this analyze-only pass
      // otherwise skips because it stops before instantiation, leaving the
      // runtime to recompile and fail to persist them on a read-only image.
      // Pre-compiling every `Telo.Definition` schema here writes them into the
      // same content-addressed `__validators/` cache the runtime reads.
      precompileDefinitionSchemas(staticManifests, this.sharedSchemaValidator);
      // Framework/builtin controller schemas (`Telo.Import`, `Telo.Definition`,
      // the module controller, …) aren't in the static manifests but are
      // validated per-resource at runtime just the same. They're registered by
      // `loadBuiltinDefinitions` above, so bake them from the registry.
      precompileDefinitionSchemas(
        this.controllers.getControllerSchemas().map((schema) => ({
          kind: "Telo.Definition",
          schema,
        })),
        this.sharedSchemaValidator,
      );
      return;
    }

    // Load runtime configuration — root module gets access to host env.
    // Imports are loaded separately via the import-controller; this load is
    // entry-only with compile-time CEL.
    // `desugarImports` so inline `imports:` entries become real Telo.Import
    // manifests in the runtime manifest list — `registerManifest` below then
    // routes them to the import-controller, which actually loads and runs them.
    // Without it (analysis-only desugar) inline imports would pass validation
    // and then never execute.
    const lm = await this.loader.loadModule(sourceUrl, { compile: true, desugarImports: true });
    const allManifests = flattenLoadedModule(lm);

    // Phase 2: normalize inline resources — extract inline values from x-telo-ref slots
    // into first-class named manifests and replace them in-place with {kind, name} references.
    // Update staticManifests so Phase 3 (validateReferences) and Phase 4 (DAG) see
    // the same normalized structure.
    // Pass the analyzer-flattened set (entry + forwarded library exports) as cross-module
    // resolution targets so `!ref Alias.name` in the entry-only runtime manifests resolves
    // to imported libraries' exported instances.
    const normalizedManifests = this.analyzer.normalize(
      allManifests,
      this.registry,
      staticManifests,
    );
    this.staticManifests = normalizedManifests;

    let rootApplicationManifest: ResourceManifest | undefined;
    for (const manifest of normalizedManifests) {
      if (isModuleKind(manifest.kind)) {
        // Root is always Telo.Application (Library root rejected above).
        // Application-level `variables` / `secrets` declarations carry an `env:`
        // mapping per field; the kernel populates the root scope from
        // `process.env` after the manifest loop so imports can read
        // `${{ variables.X }}` during their own init.
        //
        // Targets are preserved as their full shape so the boot runner can
        // evaluate `when` guards and inline invoke steps. The analyzer's
        // `resolveRefSentinels` pass already substituted any `!ref <name>` to
        // `{kind, name}` (including inside an inline target's `invoke`).
        // Recognized shapes: bare string ref, resolved `{kind, name}`, gated
        // `{ ref, when? }`, and inline `{ name?, invoke, inputs?, when?, retry? }`.
        // Anything else (e.g. an unresolved sentinel, or a malformed manifest)
        // is a hard error — silently dropping the entry would leave the user
        // staring at a "no targets ran" outcome with no signal.
        const rawTargets = (manifest.targets ?? []) as unknown[];
        rawTargets.forEach((t, index) => {
          const ok =
            typeof t === "string" ||
            (!!t &&
              typeof t === "object" &&
              (typeof (t as { name?: unknown }).name === "string" ||
                (t as { ref?: unknown }).ref != null ||
                (t as { invoke?: unknown }).invoke !== undefined));
          if (!ok) {
            throw new RuntimeError(
              "ERR_INVALID_VALUE",
              `Telo.Application '${(manifest.metadata as { name?: string } | undefined)?.name ?? "(unnamed)"}' targets[${index}] is not a recognized target shape. Got: ${JSON.stringify(t)}`,
            );
          }
        });
        this.rootContext.setTargets(rawTargets as BootTarget[]);
        if (manifest.kind === "Telo.Application") {
          rootApplicationManifest = manifest;
          this._appName = (manifest.metadata as { name?: string } | undefined)?.name;
        }
      }
      this.rootContext.registerManifest(manifest);
    }

    if (rootApplicationManifest) {
      const { variables, secrets, ports } = resolveApplicationEnv(
        rootApplicationManifest as Record<string, any>,
        this.env,
        this.sharedSchemaValidator,
      );
      if (Object.keys(variables).length > 0) {
        this.rootContext.setVariables(variables);
      }
      if (Object.keys(secrets).length > 0) {
        this.rootContext.setSecrets(secrets);
      }
      if (Object.keys(ports).length > 0) {
        this.rootContext.setPorts(ports);
      }
      const portDecls = (rootApplicationManifest as { ports?: Record<string, { protocol?: string }> })
        .ports ?? {};
      this._resolvedPorts = Object.entries(ports).map(([name, port]) => ({
        name,
        port,
        protocol: portDecls[name]?.protocol === "udp" ? "udp" : "tcp",
      }));
    }
  }

  /**
   * Resolved inbound ports from the root Application's `ports:` block, available
   * after {@link load}. Each carries the resolved integer and its declared
   * protocol; empty when the root declares no ports (or isn't an Application).
   * Surfaced so a host (e.g. the CLI inspection endpoint) can tell the debug UI
   * where the running app is reachable.
   */
  getResolvedPorts(): ReadonlyArray<{ name: string; port: number; protocol: "tcp" | "udp" }> {
    return this._resolvedPorts;
  }

  /**
   * Initialize every resource declared in the manifest. Does not run targets
   * and does not wait — returns as soon as the kernel is ready to accept
   * `invoke()` calls.
   *
   * Throws ERR_KERNEL_STATE_INVALID if `load()` was not called first, on
   * second call, or after teardown.
   */
  async boot(): Promise<void> {
    if (this._isTornDown) {
      throwInvalidState("boot", "kernel has been torn down");
    }
    if (this._bootCalled) {
      throwInvalidState("boot", "boot() already called");
    }
    if (this._entryUrl === undefined) {
      throwInvalidState("boot", "load() has not been called");
    }
    this._bootCalled = true;

    // Call register hooks for controllers actually loaded at this point (built-ins).
    // User-module kinds load their controllers during Phase 3 (Telo.Definition.init),
    // and registerController() fires their register hook there.
    for (const kind of this.controllers.getControllerKinds()) {
      const controller = this.controllers.getController(kind);
      if (controller.register) {
        await controller.register(this.createControllerContext(`controller:${kind}`));
      }
    }

    // Phase 3+4: reference validation, cycle detection, and topo sort
    const {
      diagnostics: refErrors,
      order,
      cycleError,
    } = this.analyzer.prepare(this.staticManifests, this.registry);
    if (refErrors.length > 0) {
      throw new RuntimeError(
        "ERR_MANIFEST_VALIDATION_FAILED",
        "Manifest validation failed",
        refErrors.map((d) => ({
          severity: "error" as const,
          message: d.message,
          code: d.code !== undefined ? String(d.code) : undefined,
          resource: (d.data as any)?.resource
            ? `${(d.data as any).resource.kind}.${(d.data as any).resource.name}`
            : undefined,
        })),
      );
    }
    if (cycleError) {
      throw new RuntimeError("ERR_CIRCULAR_DEPENDENCY", cycleError);
    }

    // Phase 5: sort pending resources into topo order so injection always finds
    // initialized dependencies, then run the init loop.
    if (order) {
      this.rootContext.setInitOrder(order);
    }

    await this.rootContext.initializeResources();
    await this.eventBus.emit("Kernel.Initialized", {});

    this._isBooted = true;
  }

  /**
   * Run the manifest's `targets` (Telo.Service / Telo.Runnable instances).
   * Emits Kernel.Starting before, Kernel.Started after.
   *
   * Throws ERR_KERNEL_STATE_INVALID if called before `boot()` completes, after
   * teardown, or a second time.
   */
  async runTargets(): Promise<void> {
    if (this._isTornDown) {
      throwInvalidState("runTargets", "kernel has been torn down");
    }
    if (!this._isBooted) {
      throwInvalidState("runTargets", "boot() has not completed");
    }
    if (this._targetsRan) {
      throwInvalidState("runTargets", "runTargets() already called");
    }
    this._targetsRan = true;

    await this.eventBus.emit("Kernel.Starting", {});
    await this.rootContext.runTargets(this.bootCancellation.context, this._appName);
    await this.eventBus.emit("Kernel.Started", {});
  }

  /** The boot run's cancellation source, created on first access so a signal
   *  handler can cancel even before `runTargets()` begins. */
  private get bootCancellation(): CancellationSource {
    if (!this._bootCancellation) this._bootCancellation = createCancellationSource();
    return this._bootCancellation;
  }

  /**
   * Cooperatively cancel the boot `targets` run. Not-yet-started targets are
   * refused at the dispatch gate; long-lived runnables and in-flight invoke
   * trees observe the token (`ctx.cancellation`) and stop early. Used by the
   * CLI's SIGINT/SIGTERM handler. Safe to call before or after `runTargets()`.
   */
  cancel(reason = "cancelled"): void {
    this.bootCancellation.cancel(reason);
  }

  /**
   * Tear down every initialized resource. Emits Kernel.Stopping before,
   * Kernel.Stopped after. Idempotent — second call is a no-op (does not
   * re-emit). Tolerates partial state — a boot() that threw mid-init still
   * cleans up whichever resources had initialized.
   */
  async teardown(): Promise<void> {
    if (this._isTornDown) return;
    this._isTornDown = true;

    await this.eventBus.emit("Kernel.Stopping", {});
    if (this.rootContext) {
      await this.rootContext.teardownResources();
    }
    // Drop the load-time graph so a teardown'd kernel doesn't pin every
    // manifest file's text in memory (LoadedFile retains the parsed
    // documents + the original YAML bytes). Reusing the kernel after
    // teardown is a hard error elsewhere, so this is purely a memory
    // hygiene step.
    this._loadedGraph = undefined;
    this.staticManifests = [];
    await this.eventBus.emit("Kernel.Stopped", { exitCode: this._exitCode });
  }

  /**
   * Convenience: boot → runTargets → waitForIdle → teardown. The try wraps
   * boot() and runTargets() too — init-time failures still drive teardown and
   * still emit Kernel.Stopping / Kernel.Stopped, matching pre-split semantics.
   */
  async start(): Promise<void> {
    try {
      await this.boot();
      await this.runTargets();
      await this.waitForIdle();
    } finally {
      await this.teardown();
    }
  }

  /**
   * Invoke a Telo.Invocable resource by `<kind>.<name>` (dot-form) or
   * `{ kind, name }`. Resolves through the root module context, so the same
   * dispatch, error path, and event emission that controller-to-controller
   * invokes use apply here too.
   */
  async invoke<TInputs = any, TOutput = any>(
    ref: string | { kind: string; name: string },
    inputs: TInputs,
    opts?: InvokeOptions,
  ): Promise<TOutput> {
    if (this._isTornDown) {
      throwInvalidState("invoke", "kernel has been torn down");
    }
    if (!this._isBooted) {
      throwInvalidState("invoke", "boot() has not completed");
    }
    const parsed = typeof ref === "string" ? parseRef(ref) : ref;
    const source = seedInvokeSource(opts);
    try {
      return (await this.rootContext.invoke(
        parsed.kind,
        parsed.name,
        inputs,
        source?.context,
      )) as TOutput;
    } finally {
      source?.dispose();
    }
  }

  async emitRuntimeEvent(event: string, payload?: any): Promise<void> {
    await this.eventBus.emit(event, payload);
  }

  /**
   * URL of the entry manifest passed to `load()`, or `undefined` before
   * `load()` has been called. Used by controllers and the controller-loader
   * to anchor per-manifest install roots so every resource in the process
   * shares a single `node_modules` tree (and therefore one realpath for
   * `@telorun/sdk`).
   */
  getEntryUrl(): string | undefined {
    return this._entryUrl;
  }

  /** The npm install root for this load (`<cache-root>/npm`), threaded to the
   *  controller loader so it doesn't re-derive it from the entry URL. */
  getInstallRoot(): string | undefined {
    return this._cacheRoot ? `${this._cacheRoot}/npm` : undefined;
  }

  /** Authored `kind` of a declared resource by name, from the static manifest
   *  set. Init-order-independent (unlike `resourceInstances`), so a controller
   *  resolving a `!ref <name>` sentinel before the target initializes can still
   *  recover the kind for invocation-event naming. */
  resourceKindByName(name: string): string | undefined {
    for (const m of this.staticManifests) {
      if (m.metadata?.name === name && typeof m.kind === "string") return m.kind;
    }
    return undefined;
  }

  get exitCode(): number {
    return this._exitCode;
  }

  requestExit(code: number): void {
    this._exitCode = Math.max(this._exitCode, code);
  }

  acquireHold(reason?: string): () => void {
    this.holdCount += 1;
    if (this.holdCount === 1) {
      void this.eventBus.emit("Kernel.Blocked", {
        reason,
        count: this.holdCount,
      });
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.holdCount = Math.max(0, this.holdCount - 1);
      if (this.holdCount === 0) {
        const resolvers = this.idleResolvers.splice(0);
        for (const resolve of resolvers) {
          resolve();
        }
        void this.eventBus.emit("Kernel.Unblocked", { count: this.holdCount });
      }
    };
  }

  waitForIdle(): Promise<void> {
    if (this.holdCount === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  /**
   * Force-resolve any pending `waitForIdle()` even when holds are still active.
   * Used by external signal handlers (SIGINT/SIGTERM) to unblock graceful exit
   * so `start()`'s waitForIdle returns and its finally clause runs `teardown()`.
   *
   * Does not tear down on its own — call `teardown()` directly if you're not
   * inside `start()`.
   */
  forceIdle(): void {
    const resolvers = this.idleResolvers.splice(0);
    for (const resolve of resolvers) resolve();
  }

  hasEventHandlers(event: string): boolean {
    return this.eventBus.hasHandlers(event);
  }

  /**
   * Turn invocation tracing on/off. A debug consumer (the CLI debug server) flips
   * it on while attached: invocations then mint monotonic ids and emit
   * `invocationId` / `parentInvocationId` in event metadata, so the consumer can
   * rebuild the call tree. Off by default — zero overhead when nobody is watching.
   */
  setTracing(enabled: boolean): void {
    this.tracer.enabled = enabled;
  }

  on(event: string, handler: (event: RuntimeEvent) => void | Promise<void>): void {
    this.eventBus.on(event, handler);
  }

  private createControllerContext(kind: string): ControllerContext {
    return {
      on: (event: string, handler: (event: RuntimeEvent) => void | Promise<void>) =>
        this.eventBus.on(event, handler),
      emit: (event: string, payload?: any) => {
        const namespaced = event.includes(".") ? event : `${kind}.${event}`;
        void this.eventBus.emit(namespaced, payload);
      },
      acquireHold: (reason?: string) => this.acquireHold(reason),
      expandValue: (value: any, context: Record<string, any>) =>
        this.rootContext.expandWith(value, context),
      requestExit: (code: number) => this.requestExit(code),
    };
  }

  /**
   * Walk up the parent chain from a given evaluation context to find the nearest
   * ModuleContext ancestor. Falls back to rootContext if none found.
   */
  private findModuleContext(ctx: IEvaluationContext): IModuleContext {
    return findEnclosingModule(ctx) ?? this.rootContext;
  }

  private createResourceContext(
    moduleContext: IModuleContext,
    resource: ResourceManifest,
    args?: ParsedArgs,
    ownerPrefix = "",
  ): ResourceContext {
    return new ResourceContextImpl(
      this,
      moduleContext,
      resource.metadata,
      this.sharedSchemaValidator,
      this.env,
      this.stdin,
      this.stdout,
      this.stderr,
      args,
      ownerPrefix,
    );
  }

  /**
   * Parse kernel.argv using a controller's args spec (if present).
   * If the controller exports no args spec, does a generic parse.
   */
  private parseArgsForController(controller: any): ParsedArgs {
    if (this.argv.length === 0) return { _: [] };

    const argSpec = controller.args;
    if (argSpec) {
      const options: Record<string, { type: "string" | "boolean"; short?: string }> = {};
      for (const [name, def] of Object.entries(argSpec) as [string, any][]) {
        options[name] = { type: def.type ?? "string" };
        if (def.alias) options[name].short = def.alias;
      }
      const { values, positionals } = parseArgs({
        args: this.argv,
        options,
        allowPositionals: true,
        strict: false,
      });
      return { ...values, _: positionals } as ParsedArgs;
    }

    // Generic parse: no spec, best-effort
    const { values, positionals } = parseArgs({
      args: this.argv,
      allowPositionals: true,
      strict: false,
    });
    return { ...values, _: positionals } as ParsedArgs;
  }

  /**
   * Create phase only: resolves the controller, validates the schema, and calls
   * controller.create(). Returns { instance, ctx } so initializeResources can
   * run init() separately in its second phase. Returns null when the controller
   * is not yet registered (retry signal).
   */
  private async _createInstance(
    evalContext: IEvaluationContext,
    resource: ResourceManifest,
  ): Promise<{
    instance: ResourceInstance;
    ctx: ResourceContext;
    resource: ResourceManifest;
  } | null> {
    const kind = resource.kind;

    // Resolve the alias-prefixed kind to its real fully-qualified kind against the
    // declaring module's own scope. resolveKind() walks up the parent chain so root
    // built-ins (like `Telo`) remain visible from inside imported libraries; sibling
    // modules stay isolated because they're not in the chain.
    const resolvedKind = (findEnclosingModule(evalContext) ?? this.rootContext).resolveKind(kind);

    const fingerprint = policyFingerprint(findEnclosingPolicy(evalContext));
    let controller = this.controllers.getControllerOrUndefined(resolvedKind, fingerprint);
    if (!controller) {
      // Lazy controller loading: the kind's Telo.Definition registered a deferred
      // controller (resolved but not imported). Import + register it now, on this
      // first instantiation, then re-resolve. A kind with no lazy entry (abstract,
      // or genuinely unknown) falls through to the error below unchanged.
      if (await this.controllers.takeLazyController(resolvedKind, fingerprint)) {
        controller = this.controllers.getControllerOrUndefined(resolvedKind, fingerprint);
      }
    }
    if (!controller) {
      const kindInfo =
        resolvedKind !== kind ? `'${kind}' (resolved to '${resolvedKind}')` : `'${kind}'`;
      // An abstract kind has no controller by design — it's a contract for
      // `x-telo-ref` slots, not something you instantiate. Point at the concrete
      // implementations instead of the generic "no controller" message.
      if (this.registry.resolveDefinition(resolvedKind)?.kind === "Telo.Abstract") {
        const impls = this.registry.implementationsOf(resolvedKind);
        const hint = impls.length
          ? `instantiate a concrete implementation: ${impls.join(", ")}`
          : "no concrete implementations are registered — import a module that provides one";
        throw new Error(
          `Kind ${kindInfo} is abstract and cannot be instantiated directly; ${hint}.`,
        );
      }
      throw new Error(
        `No controller registered for kind ${kindInfo} (runtime fingerprint "${fingerprint}"), known controllers are: ${this.controllers.getKinds().join(", ")}`,
      );
    }

    if (!controller.create) {
      throw new RuntimeError(
        "ERR_CONTROLLER_INVALID",
        `Controller for ${kind} does not implement create method`,
      );
    }
    if (!controller.schema?.type) {
      throw new Error(`No schema defined for ${kind} controller`);
    }

    // Resolve eval paths from x-telo-eval annotations in the parent and own schema
    const definition = this.controllers.getDefinition(resolvedKind);
    const parentDef = definition?.capability
      ? this.controllers.getDefinition(definition.capability)
      : undefined;
    const parentEval = parentDef?.schema
      ? buildEvalPaths(parentDef.schema)
      : { compile: [], runtime: [] };
    const ownEval = definition?.schema
      ? buildEvalPaths(definition.schema)
      : { compile: [], runtime: [] };
    const compile = [...parentEval.compile, ...ownEval.compile];
    const runtime = [...parentEval.runtime, ...ownEval.runtime];

    // Schema validation runs before CEL evaluation so it sees the original manifest
    // shape. CompiledValue wrappers (from load-time precompilation) are stripped,
    // restoring the pre-CEL string view that the schema expects.
    try {
      this.sharedSchemaValidator
        .compile(controller.schema)
        .validate(stripCompiledValues(resource, controller.schema as Record<string, unknown>));
    } catch (error) {
      throw new RuntimeError(
        "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED",
        `Resource does not match schema for kind ${kind}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Expand compile-time CEL fields before passing to the controller.
    const processedResource = compile.length
      ? (evalContext.expandPaths(
          resource as Record<string, unknown>,
          compile,
          runtime,
        ) as ResourceManifest)
      : resource;

    const parsedArgs = this.parseArgsForController(controller);
    const moduleCtx = this.findModuleContext(evalContext);
    const ctx = this.createResourceContext(
      moduleCtx,
      processedResource,
      parsedArgs,
      evalContext.ownerPrefix,
    );
    const instance = await controller.create(processedResource, ctx);
    if (!instance) return null;

    // Fold the resource's fire-and-forget drain into its own teardown: tearing
    // the resource down drains the background tasks it spawned (the kernel just
    // calls teardown() — it tracks no tasks itself). A drain with no pending
    // tasks is a no-op, so this is safe for every resource.
    const ownerCtx = ctx as ResourceContextImpl;
    const originalTeardown = instance.teardown?.bind(instance);
    instance.teardown = async () => {
      await ownerCtx.drainDetached();
      if (originalTeardown) await originalTeardown();
    };

    if (!runtime.length) return { instance, ctx, resource: processedResource };

    // Override invoke in-place so all lifecycle methods (init/invoke/teardown/snapshot)
    // share the same `this`. A wrapper object would split identity: state mutated by
    // init() on the wrapper would be invisible to the original invoke(), which still
    // runs with `this === instance`. Mutating in place also preserves the prototype
    // chain — class-declared methods remain reachable.
    const originalInvoke = instance.invoke!.bind(instance);
    instance.invoke = async (inputs: any) => {
      const expanded = evalContext.expandPaths(inputs as Record<string, unknown>, runtime);
      return originalInvoke(expanded);
    };
    return { instance, ctx, resource: processedResource };
  }

  /**
   * Phase 5 — Inject live instances into reference fields of a resource config.
   *
   * Called between create() and init() for every resource. Walks the definition's
   * field map and replaces each {kind, name} reference value (outside scope visibility
   * paths) with the live ResourceInstance returned by getInstance(name). Fields within
   * scope paths are left as {kind, name} — the controller resolves them at runtime.
   */
  private _injectDependencies(
    resource: ResourceManifest,
    getInstance: (name: string, alias?: string) => ResourceInstance | undefined,
    isPending?: (name: string) => boolean,
  ): void {
    this.registry.iterateFieldEntries(
      resource,
      (fieldPath) => injectAtPath(resource, fieldPath, getInstance, isPending),
      (fieldPath) => {
        const val = (resource as Record<string, unknown>)[fieldPath];
        if (Array.isArray(val)) {
          (resource as Record<string, unknown>)[fieldPath] = this.rootContext.createScopeHandle(
            val as ResourceManifest[],
          );
        }
      },
    );
  }
}
