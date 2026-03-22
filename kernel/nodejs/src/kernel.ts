import {
  AliasResolver,
  DefinitionRegistry,
  DiagnosticSeverity,
  KERNEL_BUILTINS,
  StaticAnalyzer,
  buildDependencyGraph,
  formatCycle,
  isRefEntry,
  isScopeEntry,
  normalizeInlineResources,
  validateReferences,
  type AnalysisContext,
} from "@telorun/analyzer";
import {
  ControllerContext,
  Kernel as IKernel,
  ModuleContext,
  ResourceContext,
  ResourceDefinition,
  ResourceInstance,
  ResourceManifest,
  RuntimeError,
  RuntimeEvent,
  isCompiledValue,
} from "@telorun/sdk";
import * as path from "path";
import { ControllerRegistry } from "./controller-registry.js";
import { EventStream } from "./event-stream.js";
import { EventBus } from "./events.js";
import { Loader } from "./loader.js";
import { ResourceContextImpl } from "./resource-context.js";
import { SchemaValidator } from "./schema-valiator.js";

/**
 * Kernel: Central orchestrator managing lifecycle and message bus
 * Handles resource loading, initialization, and execution through controllers
 */
export class Kernel implements IKernel {
  private loader: Loader = new Loader();
  // private manifests: ManifestRegistry = new ManifestRegistry();
  private controllers: ControllerRegistry = new ControllerRegistry();
  private eventBus: EventBus = new EventBus();
  private eventStream: EventStream = new EventStream();
  // private snapshotSerializer: SnapshotSerializer = new SnapshotSerializer();
  // private runtimeManifests: ResourceManifest[] | null = null;
  // private resourceInstances: Map<
  //   string,
  //   { resource: ResourceManifest; instance: ResourceInstance }
  // > = new Map();

  private holdCount = 0;
  private idleResolvers: Array<() => void> = [];
  private _exitCode = 0;
  // private bootContextRegistry = new BootContextRegistry();
  private readonly sharedSchemaValidator = new SchemaValidator();
  private rootContext!: ModuleContext;
  private readonly analyzerDefs = new DefinitionRegistry();
  private readonly analyzerAliases = new AliasResolver();
  private staticManifests: ResourceManifest[] = [];

  constructor() {
    this.setupEventStreaming();
  }

  // async teardownResource(module: string, kind: string, name: string): Promise<void> {
  //   const key = this.getResourceKey(module, kind, name);
  //   const entry = this.resourceInstances.get(key);
  //   if (!entry) return;
  //   const { resource, instance } = entry;
  //   if (instance.teardown) {
  //     await instance.teardown();
  //   }
  //   await this.eventBus.emit(`${resource.kind}.${resource.metadata.name}.Teardown`, {
  //     resource: { kind: resource.kind, name: resource.metadata.name },
  //   });
  //   // this.resourceInstances.delete(key);
  //   this.resourceEventBuses.delete(key);
  // }

  async registerController(
    moduleName: string,
    kindName: string,
    controllerInstance: any,
  ): Promise<void> {
    this.controllers.registerController(`${moduleName}.${kindName}`, controllerInstance);
    await controllerInstance.register?.(this.createControllerContext(`${moduleName}.${kindName}`));
  }

  /**
   * Register a resource definition with the controller registry
   */
  registerResourceDefinition(
    definition: ResourceDefinition,
    // basePath?: string,
    // namespace?: string | null,
  ): void {
    this.controllers.registerDefinition(definition);
    this.analyzerDefs.register(definition);
  }

  getModuleContext(_moduleName: string): ModuleContext {
    return this.rootContext;
  }

  resolveModuleAlias(_declaringModule: string, alias: string): string | undefined {
    return this.rootContext.importAliases.get(alias);
  }

  registerModuleImport(
    _declaringModule: string,
    alias: string,
    targetModule: string,
    kinds: string[],
  ): void {
    this.rootContext.registerImport(alias, targetModule, kinds);
    this.analyzerAliases.registerImport(alias, targetModule, kinds);
  }

  /** Returns the live analysis context backed by this kernel's known definitions and aliases.
   *  Passes to StaticAnalyzer.analyze() for incremental validation of new manifests against
   *  already-registered types (e.g. front-end editor validating a manifest before submitting). */
  getAnalysisContext(): AnalysisContext {
    return { aliases: this.analyzerAliases, definitions: this.analyzerDefs };
  }

  /**
   * Load built-in Runtime definitions (e.g., Kernel.Module)
   * Also declares all known module namespaces upfront so that resources can be
   * registered to them. User-defined modules are declared explicitly by Kernel.Module
   * resources during the initialization phase.
   */
  private async loadBuiltinDefinitions(): Promise<void> {
    // Declare built-in module namespaces upfront so getContext() can distinguish
    // "not yet populated" from a completely unknown module name.
    this.rootContext.registerImport("Kernel", "Kernel", []); // built-ins, unrestricted

    // Register built-in definitions (abstracts + Kernel.Definition + Kernel.Module)
    for (const def of KERNEL_BUILTINS) this.registerResourceDefinition(def);

    this.controllers.registerController(
      "Kernel.Definition",
      await import("./controllers/resource-definition/resource-definition-controller.js"),
    );
    this.controllers.registerController(
      "Kernel.Module",
      await import("./controllers/module/module-controller.js"),
    );
    this.controllers.registerController(
      "Kernel.Import",
      await import("./controllers/module/import-controller.js"),
    );
  }

  /**
   * Load from runtime configuration file
   */
  async loadFromConfig(runtimeYamlPath: string): Promise<void> {
    this.rootContext = new ModuleContext(
      this.loader.resolvePath(`file://${process.cwd()}/`, runtimeYamlPath),
      {},
      {},
      {},
      [],
      this._createInstance.bind(this),
      (event, payload) => this.eventBus.emit(event, payload),
    );
    // Initialize built-in Runtime definitions first
    await this.loadBuiltinDefinitions();

    // Phase 5: attach injection hook — fires between create() and init() for every resource
    this.rootContext.preInitHook = (resource, getInstance) =>
      this._injectDependencies(resource, getInstance);

    // Static analysis pre-flight: validates schemas and invocation context compatibility.
    // All errors are fatal — kernel does not start if analysis fails.
    const staticManifests = await this.loader.loadManifests(runtimeYamlPath);
    this.staticManifests = staticManifests;

    // Register module identities for x-telo-ref resolution (Phase 3 prerequisite).
    // Kernel built-ins ("kernel" → "Kernel") are auto-registered when Kernel.Abstract
    // definitions are registered in loadBuiltinDefinitions() above.
    for (const m of staticManifests) {
      if (m.kind === "Kernel.Module" && m.metadata?.name && m.metadata?.namespace) {
        this.analyzerDefs.registerModuleIdentity(
          m.metadata.namespace as string,
          m.metadata.name as string,
        );
      }
    }

    const diagnostics = new StaticAnalyzer().analyze(
      staticManifests,
      {},
      this.getAnalysisContext(),
    );
    const errors = diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error);
    if (errors.length > 0) {
      const summary = errors.map((d) => d.message).join("\n");
      throw new RuntimeError("ERR_MANIFEST_VALIDATION_FAILED", summary);
    }

    // Load runtime configuration — root module gets access to host env
    const allManifests = await this.loader.loadManifest(
      runtimeYamlPath,
      `file://${process.cwd()}/`,
      { env: process.env },
    );

    // Phase 2: normalize inline resources — extract inline values from x-telo-ref slots
    // into first-class named manifests and replace them in-place with {kind, name} references.
    // Update staticManifests so Phase 3 (validateReferences) and Phase 4 (DAG) see
    // the same normalized structure.
    const normalizedManifests = normalizeInlineResources(
      allManifests,
      this.analyzerDefs,
      this.analyzerAliases,
    );
    this.staticManifests = normalizedManifests;

    for (const manifest of normalizedManifests) {
      if (manifest.kind === "Kernel.Module") {
        this.rootContext.setSecrets(manifest.secrets ?? {});
        this.rootContext.setVariables(manifest.variables ?? {});
        this.rootContext.setTargets(manifest.targets ?? []);
      }
      this.rootContext.registerManifest(manifest);
    }
  }

  /**
   * Phase 1: Load - Ingest files from directory and load runtime config
   * @deprecated Use loadFromConfig instead
   */
  async loadDirectory(dirPath: string): Promise<void> {
    const configYamlPath = path.join(dirPath, "module.yaml");

    await this.loadFromConfig(configYamlPath);
  }

  /**
   * Phase 2: Start - Initialize resources
   */
  async start(): Promise<void> {
    // Call controller register hooks first (before any initialization)
    for (const kind of this.controllers.getKinds()) {
      const controller = this.controllers.getController(kind);
      if (controller?.register) {
        await controller.register(this.createControllerContext(`controller:${kind}`));
      }
    }

    // Phase 3: reference validation — kind and resolution checks
    const refDiagnostics = validateReferences(this.staticManifests, this.getAnalysisContext());
    const refErrors = refDiagnostics.filter((d) => d.severity === DiagnosticSeverity.Error);
    if (refErrors.length > 0) {
      throw new RuntimeError(
        "ERR_MANIFEST_VALIDATION_FAILED",
        refErrors.map((d) => d.message).join("\n"),
      );
    }

    // Phase 4: dependency graph — cycle detection before any resource is initialized
    const graph = buildDependencyGraph(
      this.staticManifests,
      this.analyzerDefs,
      this.analyzerAliases,
    );
    if (graph.cycle) {
      throw new RuntimeError("ERR_CIRCULAR_DEPENDENCY", formatCycle(graph.cycle));
    }

    // Phase 5: sort pending resources into topo order so injection always finds
    // initialized dependencies, then run the init loop.
    if (graph.order) {
      this.rootContext.setInitOrder(graph.order.map((n) => n.name));
    }

    // Initialize resources
    try {
      await this.rootContext.initializeResources();
      await this.eventBus.emit("Kernel.Initialized", {});
      await this.eventBus.emit("Kernel.Starting", {});
      await this.rootContext.runTargets();
      await this.eventBus.emit("Kernel.Started", {});
      await this.waitForIdle();
    } finally {
      await this.eventBus.emit("Kernel.Stopping", {});
      await this.rootContext.teardownResources();
      await this.eventBus.emit("Kernel.Stopped", { exitCode: this._exitCode });
    }
  }

  // async runInstances(): Promise<void> {
  //   for (const { instance } of this.resourceInstances.values()) {
  //     if (instance.run) {
  //       await instance.run();
  //     }
  //   }
  // }

  async emitRuntimeEvent(event: string, payload?: any): Promise<void> {
    await this.eventBus.emit(event, payload);
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
   * Force-resolve waitForIdle() regardless of active holds.
   * Used for graceful shutdown when external signals (e.g. SIGINT) should
   * bypass resource holds and proceed directly to teardown.
   */
  shutdown(): void {
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
      once: (event: string, handler: (event: RuntimeEvent) => void | Promise<void>) =>
        this.eventBus.once(event, handler),
      off: (event: string, handler: (event: RuntimeEvent) => void | Promise<void>) =>
        this.eventBus.off(event, handler),
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

  private createResourceContext(
    moduleContext: ModuleContext,
    resource: ResourceManifest,
  ): ResourceContext {
    return new ResourceContextImpl(
      this,
      moduleContext,
      resource.metadata,
      this.sharedSchemaValidator,
    );
  }

  /**
   * Create phase only: resolves the controller, validates the schema, and calls
   * controller.create(). Returns { instance, ctx } so initializeResources can
   * run init() separately in its second phase. Returns null when the controller
   * is not yet registered (retry signal).
   */
  private async _createInstance(
    evalContext: ModuleContext,
    resource: ResourceManifest,
  ): Promise<{ instance: ResourceInstance; ctx: ResourceContext } | null> {
    const kind = resource.kind;

    // Resolve the alias-prefixed kind to its real fully-qualified kind.
    // resolveKind() throws with a clear message if the alias or kind is not found.
    const resolvedKind = this.rootContext.resolveKind(kind);

    const controller = this.controllers.getControllerOrUndefined(resolvedKind);
    if (!controller) {
      const kindInfo =
        resolvedKind !== kind ? `'${kind}' (resolved to '${resolvedKind}')` : `'${kind}'`;
      throw new Error(
        `No controller registered for kind ${kindInfo}, known controllers are: ${this.controllers.getKinds().join(", ")}`,
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

    // Resolve expand paths from the parent base definition and the definition itself
    const definition = this.controllers.getDefinition(resolvedKind);
    const parentDef = definition?.extends
      ? this.controllers.getDefinition(definition.extends)
      : undefined;
    const compile = [...(parentDef?.expand?.compile ?? []), ...(definition?.expand?.compile ?? [])];
    const runtime = [...(parentDef?.expand?.runtime ?? []), ...(definition?.expand?.runtime ?? [])];

    // Schema validation runs before CEL evaluation so it sees the original manifest
    // shape. CompiledValue wrappers (from load-time precompilation) are stripped,
    // restoring the pre-CEL string view that the schema expects.
    try {
      this.sharedSchemaValidator.compile(controller.schema).validate(stripCompiledValues(resource));
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

    const ctx = this.createResourceContext(evalContext, processedResource);
    const instance = await controller.create(processedResource, ctx);
    if (!instance) return null;

    if (!runtime.length) return { instance, ctx };

    const wrapped: ResourceInstance = {
      ...instance,
      invoke: async (inputs: any) => {
        const expanded = evalContext.expandPaths(inputs as Record<string, unknown>, runtime);
        return instance.invoke!(expanded);
      },
    };
    return { instance: wrapped, ctx };
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
    getInstance: (name: string) => ResourceInstance | undefined,
  ): void {
    const resolvedKind = this.analyzerAliases.resolveKind(resource.kind) ?? resource.kind;
    const fieldMap =
      this.analyzerDefs.getFieldMap(resource.kind) ?? this.analyzerDefs.getFieldMap(resolvedKind);
    if (!fieldMap) return;

    for (const [fieldPath, entry] of fieldMap) {
      if (isScopeEntry(entry)) {
        // Replace the raw manifest array with a ScopeHandle the controller calls at runtime.
        const val = (resource as Record<string, unknown>)[fieldPath];
        if (Array.isArray(val)) {
          (resource as Record<string, unknown>)[fieldPath] = this.rootContext.createScopeHandle(
            val as ResourceManifest[],
          );
        }
        continue;
      }

      if (!isRefEntry(entry)) continue;

      // Inject outer (singleton) instances. injectAtPath is a no-op when getInstance
      // returns undefined — that is the case for resources declared inside a scope field
      // (they are not initialized at boot), so they correctly stay as {kind, name} for the
      // controller to resolve at runtime via ScopeContext.getInstance().
      injectAtPath(resource, fieldPath, getInstance);
    }
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

/** Replaces CompiledValue wrappers with "" for schema validation.
 *  Template strings were raw strings in YAML before precompilation and passed
 *  string-type checks. This preserves that behavior without evaluating expressions. */
function stripCompiledValues(v: unknown): unknown {
  if (isCompiledValue(v)) return "";
  if (Array.isArray(v)) return v.map(stripCompiledValues);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = stripCompiledValues(val);
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
function injectAtPath(
  resource: ResourceManifest,
  fieldPath: string,
  getInstance: (name: string) => ResourceInstance | undefined,
): void {
  const parts = fieldPath.split(".");

  function traverse(obj: unknown, partsLeft: string[]): void {
    if (!obj || typeof obj !== "object" || partsLeft.length === 0) return;
    const [head, ...rest] = partsLeft;
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
            const instance = getInstance(ref.name);
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
            const instance = getInstance(ref.name);
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
