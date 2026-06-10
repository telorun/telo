import {
  AnalysisRegistry,
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
  isCompiledValue,
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
import { createHash, createHmac } from "node:crypto";
import { parseArgs } from "util";
import { ControllerRegistry } from "./controller-registry.js";
import { EventStream } from "./event-stream.js";
import { EventBus } from "./events.js";
import { ModuleContext } from "./module-context.js";
import { ResourceContextImpl } from "./resource-context.js";
import {
  computeAnalysisSignature,
  readAnalysisStamp,
  writeAnalysisStamp,
} from "./manifest-sources/analysis-stamp.js";
import { resolveEntryDir } from "./manifest-sources/local-manifest-cache-source.js";
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

/** Translate embedder `InvokeOptions` (external signal / absolute deadline)
 *  into a seeded cancellation source, or `undefined` when nothing was requested
 *  so the dispatch path stays on its allocation-free sentinel. The caller
 *  disposes the returned source once the invoke settles. */
function seedInvokeSource(opts?: InvokeOptions): CancellationSource | undefined {
  if (!opts?.signal && opts?.deadlineAt === undefined) return undefined;
  const source = createCancellationSource();
  if (opts.deadlineAt !== undefined) source.cancelAt(opts.deadlineAt);
  const signal = opts.signal;
  if (signal && !signal.aborted) {
    const onAbort = () => source.cancel(String(signal.reason ?? "aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    // Detach from the (possibly long-lived) external signal on dispose so the
    // listener — which captures the source — doesn't pin it until the signal
    // eventually aborts (or forever if it never does).
    const baseDispose = source.dispose.bind(source);
    source.dispose = () => {
      signal.removeEventListener("abort", onAbort);
      baseDispose();
    };
  } else if (signal?.aborted) {
    source.cancel(String(signal.reason ?? "aborted"));
  }
  return source;
}

function parseRef(ref: string): { kind: string; name: string } {
  const lastDot = ref.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === ref.length - 1) {
    throw new RuntimeError(
      "ERR_INVALID_VALUE",
      `Invalid resource reference '${ref}': expected '<Kind>.<Name>' (e.g. 'Http.Server.Main') or pass { kind, name } directly.`,
    );
  }
  return { kind: ref.slice(0, lastDot), name: ref.slice(lastDot + 1) };
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
/** Node implementations of the host-injected CEL functions (`crypto` / `Buffer`).
 *  The kernel wires these into the analyzer + loader; the CLI reuses them for
 *  `telo cel eval` so its results match a real run. */
export const nodeCelHandlers = {
  sha256: (s: string) => createHash("sha256").update(s).digest("hex"),
  md5: (s: string) => createHash("md5").update(s).digest("hex"),
  sha1: (s: string) => createHash("sha1").update(s).digest("hex"),
  sha512: (s: string) => createHash("sha512").update(s).digest("hex"),
  hmac: (algorithm: string, key: string, message: string) =>
    createHmac(algorithm, key).update(message).digest("hex"),
  base64Encode: (s: string) => Buffer.from(s, "utf8").toString("base64"),
  base64Decode: (s: string) => Buffer.from(s, "base64").toString("utf8"),
  // cel-js represents int / uint as BigInt — JSON.stringify throws on BigInts,
  // so coerce them down to Number unconditionally. CEL int is i64 and JS Number
  // is f64, so values outside ±2^53 lose precision; that's accepted behaviour
  // for Telo manifests, which never carry > 2^53 integer values in practice.
  // JSON.stringify returns undefined for top-level undefined / function / symbol
  // — the CEL signature is `json(dyn): string`, so coerce that to "null" rather
  // than break the contract. (CEL `null` already serializes to "null".)
  json: (value: unknown) =>
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v)) ?? "null",
};

export class Kernel implements IKernel {
  private readonly loader: Loader;
  private readonly analyzer = new StaticAnalyzer({ celHandlers: nodeCelHandlers });
  private readonly registry = new AnalysisRegistry();
  private controllers: ControllerRegistry = new ControllerRegistry();
  private eventBus: EventBus = new EventBus();
  private eventStream: EventStream = new EventStream();

  private holdCount = 0;
  private idleResolvers: Array<() => void> = [];
  private _exitCode = 0;
  private readonly sharedSchemaValidator = new SchemaValidator();
  private rootContext!: ModuleContext;
  private staticManifests: ResourceManifest[] = [];
  private _entryUrl?: string;
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
    this.loader = new Loader({ registryUrl: this.registryUrl, celHandlers: nodeCelHandlers });
    for (const source of options.sources) {
      this.loader.register(source);
    }
    this.setupEventStreaming();
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
    return this.loader.resolveImportUrl(fromSource, importSource);
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
  async load(url: string, options?: { analyzeOnly?: boolean }): Promise<void> {
    const sourceUrl = await this.loader.resolveEntryPoint(url);
    this._entryUrl = sourceUrl;
    // Point the shared schema validator at the entry-anchored cache so
    // compiled AJV validators are persisted (standalone CJS) under
    // `<entry-dir>/.telo/manifests/__validators/`. Memory- or HTTP-rooted
    // entries skip the cache; their schema compiles stay in-process only.
    const validatorCacheDir = resolveEntryDir(sourceUrl);
    this.sharedSchemaValidator.setCacheDir(
      validatorCacheDir
        ? `${validatorCacheDir}/.telo/manifests/__validators`
        : undefined,
    );
    this.rootContext = new ModuleContext(
      sourceUrl,
      {},
      {},
      {},
      [],
      this._createInstance.bind(this),
      (event, payload) => this.eventBus.emit(event, payload),
      this.env,
    );
    // Initialize built-in Runtime definitions first
    await this.loadBuiltinDefinitions();

    // Phase 5: attach injection hook — fires between create() and init() for every resource
    this.rootContext.preInitHook = (resource, getInstance) =>
      this._injectDependencies(resource, getInstance);

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
    const entryDir = resolveEntryDir(sourceUrl);
    const analysisSignature = computeAnalysisSignature(analysisGraph);
    const stamp = entryDir ? await readAnalysisStamp(entryDir) : undefined;
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
    if (entryDir && !skipValidation) {
      // Best-effort: stamp the verdict so subsequent loads hit the fast
      // path. A read-only filesystem (baked Docker image) reports the
      // failure on stderr and keeps running — the lookup above will
      // simply miss next time.
      try {
        await writeAnalysisStamp(entryDir, analysisSignature);
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
    }
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
    await this.rootContext.runTargets(this.bootCancellation.context);
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
    let current: IEvaluationContext | undefined = ctx;
    while (current) {
      if (current instanceof ModuleContext) return current;
      current = current.parent;
    }
    return this.rootContext;
  }

  private createResourceContext(
    moduleContext: IModuleContext,
    resource: ResourceManifest,
    args?: ParsedArgs,
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
    const controller = this.controllers.getControllerOrUndefined(resolvedKind, fingerprint);
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
    const ctx = this.createResourceContext(moduleCtx, processedResource, parsedArgs);
    const instance = await controller.create(processedResource, ctx);
    if (!instance) return null;

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
  ): void {
    this.registry.iterateFieldEntries(
      resource,
      (fieldPath) => injectAtPath(resource, fieldPath, getInstance),
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

  /**
   * Enable event streaming to a file (JSONL format)
   */
  async enableEventStream(filePath: string): Promise<void> {
    await this.eventStream.enable(filePath);
  }

  /**
   * Disable event streaming
   */
  disableEventStream(): void {
    this.eventStream.disable();
  }

  /**
   * Get the event stream for testing and inspection
   */
  getEventStream(): EventStream {
    return this.eventStream;
  }

  /**
   * Setup event streaming hook to capture all events
   */
  private setupEventStreaming(): void {
    const originalEmit = this.eventBus.emit.bind(this.eventBus);
    this.eventBus.emit = async (event: string, payload?: any) => {
      if (this.eventStream.isEnabledStream()) {
        await this.eventStream.log(event, payload);
      }
      return originalEmit(event, payload);
    };
  }
}

/** Returns a schema-appropriate placeholder value for a CompiledValue field. */
function placeholderForSchema(schema: Record<string, unknown>): unknown {
  if (schema.default !== undefined) return schema.default;
  switch (schema.type) {
    case "integer":
    case "number":
      return (schema.minimum as number | undefined) ?? 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "";
  }
}

/** Resolve a `$ref` (only `#/$defs/...` form) against the root schema. */
function resolveSchemaRef(
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
): Record<string, unknown> {
  if (
    schema.$ref &&
    typeof schema.$ref === "string" &&
    (schema.$ref as string).startsWith("#/$defs/")
  ) {
    const defName = (schema.$ref as string).slice("#/$defs/".length);
    const defs = root.$defs as Record<string, Record<string, unknown>> | undefined;
    const resolved = defs?.[defName];
    if (resolved) return resolved;
  }
  return schema;
}

/** Collect property schemas from top-level `properties` and all `oneOf`/`anyOf` sub-schemas. */
function collectSchemaProperties(
  schema: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const props: Record<string, Record<string, unknown>> = {
    ...((schema.properties ?? {}) as Record<string, Record<string, unknown>>),
  };
  for (const sub of (schema.oneOf ?? schema.anyOf ?? []) as Record<string, unknown>[]) {
    if (sub && typeof sub === "object" && sub.properties) {
      for (const [k, v] of Object.entries(
        sub.properties as Record<string, Record<string, unknown>>,
      )) {
        if (!(k in props)) props[k] = v;
      }
    }
  }
  return props;
}

/** Replaces CompiledValue wrappers with schema-appropriate placeholders for schema validation.
 *  Template strings were compiled from YAML at load time; this restores a shape
 *  that AJV can validate without evaluating expressions. */
function stripCompiledValues(
  v: unknown,
  schema: Record<string, unknown> = {},
  rootSchema?: Record<string, unknown>,
): unknown {
  const root = rootSchema ?? schema;
  const resolved = resolveSchemaRef(schema, root);

  if (isCompiledValue(v)) return placeholderForSchema(resolved);
  if (Array.isArray(v)) {
    const itemSchema = resolveSchemaRef((resolved.items ?? {}) as Record<string, unknown>, root);
    return v.map((item) => stripCompiledValues(item, itemSchema, root));
  }
  if (v !== null && typeof v === "object") {
    const props = collectSchemaProperties(resolved);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = stripCompiledValues(val, props[k] ?? {}, root);
    }
    return out;
  }
  return v;
}

/**
 * Walks `resource` following `fieldPath` (dot notation, `[]` = array traversal).
 * For each leaf value that looks like a {kind, name} reference, calls getInstance(name)
 * and replaces the value in-place with the returned live ResourceInstance.
 * Values where getInstance returns undefined are left unchanged.
 */
/**
 * Traverses a definition schema and collects all paths annotated with `x-telo-eval`.
 * Root-level `x-telo-eval` produces the `"**"` wildcard (expand all fields).
 * Property-level annotations produce the dot-notation path to that property.
 */
function buildEvalPaths(schema: Record<string, any>): { compile: string[]; runtime: string[] } {
  const compile: string[] = [];
  const runtime: string[] = [];

  if (schema["x-telo-eval"] === "compile") compile.push("**");
  else if (schema["x-telo-eval"] === "runtime") runtime.push("**");

  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties as Record<string, any>)) {
      collectEvalPathsNode(propSchema, key, compile, runtime);
    }
  }

  return { compile, runtime };
}

function collectEvalPathsNode(
  node: Record<string, any>,
  path: string,
  compile: string[],
  runtime: string[],
): void {
  if (node["x-telo-eval"] === "compile") {
    compile.push(path);
    return;
  }
  if (node["x-telo-eval"] === "runtime") {
    runtime.push(path);
    return;
  }
  if (node.properties) {
    for (const [key, propSchema] of Object.entries(node.properties as Record<string, any>)) {
      collectEvalPathsNode(propSchema, `${path}.${key}`, compile, runtime);
    }
  }
}

function injectAtPath(
  resource: ResourceManifest,
  fieldPath: string,
  getInstance: (name: string, alias?: string) => ResourceInstance | undefined,
): void {
  const parts = fieldPath.split(".");

  // Resolve a {kind, name, alias?} reference to its live instance. A non-`Self` alias is a
  // cross-module reference into an import's published exports; if that import hasn't
  // finished init() yet the instance is absent, so we throw to defer this resource to a
  // later pass of the multi-pass init loop (which catches and retries) rather than leaving
  // the ref unresolved. Local refs (no alias) that miss are left for topo ordering / later
  // diagnostics, matching prior behaviour.
  function resolveInto(ref: Record<string, unknown>): ResourceInstance | undefined {
    const alias = typeof ref.alias === "string" ? ref.alias : undefined;
    const instance = getInstance(ref.name as string, alias);
    if (!instance && alias && alias !== "Self") {
      throw new RuntimeError(
        "ERR_CROSS_MODULE_REF_PENDING",
        `Cross-module reference '${alias}.${String(ref.name)}' is not available yet (import not initialized)`,
      );
    }
    return instance;
  }

  function traverse(obj: unknown, partsLeft: string[]): void {
    if (!obj || typeof obj !== "object" || partsLeft.length === 0) return;
    const [head, ...rest] = partsLeft;

    // Map iteration: descend into every value of the current object (used for
    // schema fields with `additionalProperties` like `content[mime]`).
    if (head === "{}") {
      const container = obj as Record<string, unknown>;
      for (const mapKey of Object.keys(container)) {
        const elem = container[mapKey];
        if (!elem || typeof elem !== "object") continue;
        if (rest.length === 0) {
          const ref = elem as Record<string, unknown>;
          if (typeof ref.kind === "string" && typeof ref.name === "string") {
            const instance = resolveInto(ref);
            if (instance) container[mapKey] = instance;
          }
        } else {
          traverse(elem, rest);
        }
      }
      return;
    }

    const isArr = head.endsWith("[]");
    const key = isArr ? head.slice(0, -2) : head;
    const container = obj as Record<string, unknown>;
    const val = container[key];
    if (val == null) return;

    if (isArr) {
      if (!Array.isArray(val)) return;
      for (let i = 0; i < val.length; i++) {
        const elem = val[i];
        if (!elem || typeof elem !== "object") continue;
        if (rest.length === 0) {
          const ref = elem as Record<string, unknown>;
          if (typeof ref.kind === "string" && typeof ref.name === "string") {
            const instance = resolveInto(ref);
            if (instance) val[i] = instance;
          }
        } else {
          traverse(elem, rest);
        }
      }
    } else {
      if (rest.length === 0) {
        if (val && typeof val === "object" && !Array.isArray(val)) {
          const ref = val as Record<string, unknown>;
          if (typeof ref.kind === "string" && typeof ref.name === "string") {
            const instance = resolveInto(ref);
            if (instance) container[key] = instance;
          }
        }
      } else {
        traverse(val, rest);
      }
    }
  }

  traverse(resource, parts);
}
