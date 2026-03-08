import {
  ControllerContext,
  EvaluationContext,
  Kernel as IKernel,
  ModuleContext,
  ResourceContext,
  ResourceDefinition,
  ResourceInstance,
  ResourceManifest,
  RuntimeError,
  RuntimeEvent,
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
  private resourceEventBuses: Map<string, EventBus> = new Map();
  private holdCount = 0;
  private idleResolvers: Array<() => void> = [];
  private _exitCode = 0;
  // private bootContextRegistry = new BootContextRegistry();
  private readonly sharedSchemaValidator = new SchemaValidator();
  private rootContext!: ModuleContext;

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
  }

  registerCapability(name: string, schema?: Record<string, any>): void {
    this.controllers.registerCapability(name, schema);
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
  }

  isCapabilityRegistered(name: string): boolean {
    return this.controllers.isCapabilityRegistered(name);
  }

  getCapabilitySchema(name: string): Record<string, any> | null | undefined {
    return this.controllers.getCapabilitySchema(name);
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
    // this.moduleContextRegistry.declareModule("default"); // user resources with no module field

    this.controllers.registerDefinition({
      kind: "Kernel.Definition",
      metadata: { name: "Definition", module: "Kernel" },
      capabilities: ["template"],
      schema: { type: "object" },
    });
    this.controllers.registerController(
      "Kernel.Definition",
      await import("./controllers/resource-definition/resource-definition-controller.js"),
    );
    this.controllers.registerDefinition({
      kind: "Kernel.Definition",
      metadata: { name: "Module", module: "Kernel" },
      capabilities: ["template"],
      schema: { type: "object" },
    });
    this.controllers.registerController(
      "Kernel.Module",
      await import("./controllers/module/module-controller.js"),
    );
    this.controllers.registerDefinition({
      kind: "Kernel.Definition",
      metadata: { name: "Import", module: "Kernel" },
      capabilities: ["template"],
      schema: { type: "object" },
    });
    this.controllers.registerController(
      "Kernel.Import",
      await import("./controllers/module/import-controller.js"),
    );
    this.controllers.registerDefinition({
      kind: "Kernel.Definition",
      metadata: { name: "Capability", module: "Kernel" },
      capabilities: ["template"],
      schema: { type: "object" },
    });
    this.controllers.registerController(
      "Kernel.Capability",
      await import("./controllers/capability/capability-controller.js"),
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

    // Load built-in capability manifests before user configuration so that
    // capability resources are available in the first initialization pass
    const { fileURLToPath } = await import("url");
    const capabilitiesDir = fileURLToPath(new URL("./capabilities/", import.meta.url));
    const capabilityManifests = await this.loader.loadDirectory(capabilitiesDir);

    // Load runtime configuration — root module gets access to host env
    const userManifests = await this.loader.loadManifest(
      runtimeYamlPath,
      `file://${process.cwd()}/`,
      { env: process.env },
    );
    const allManifests = [...capabilityManifests, ...userManifests];

    for (const manifest of allManifests) {
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
        this.rootContext.merge(context).expand(value),
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
   * Create a resource instance: resolves the controller, validates the schema,
   * calls create/init, registers context providers, stores the snapshot, and
   * mirrors the instance into the Kernel-level and module-level registries.
   * Returns null when the controller is not yet registered (retry signal).
   */
  private async _createInstance(
    evalContext: ModuleContext,
    resource: ResourceManifest,
  ): Promise<ResourceInstance | null> {
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

    try {
      this.sharedSchemaValidator.compile(controller.schema).validate(resource);
    } catch (error) {
      throw new RuntimeError(
        "ERR_RESOURCE_SCHEMA_VALIDATION_FAILED",
        `Resource does not match schema for kind ${kind}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const ctx = this.createResourceContext(evalContext, resource);
    const instance = await controller.create(resource, ctx);
    if (!instance) return null;

    if (instance.init) await instance.init(ctx);

    // if (isContextProvider(instance)) {
    //   this.bootContextRegistry.register(
    //     resource.kind,
    //     resource.metadata.name,
    //     resource.metadata.module,
    //     resource.grants as string[] | undefined,
    //     instance.provideContext(),
    //   );
    // }

    if (instance.snapshot) {
      const snap = await Promise.resolve(instance.snapshot()).catch(() => ({}));
      if (evalContext instanceof ModuleContext) {
        evalContext.setResource(resource.metadata.name, (snap as Record<string, unknown>) ?? {});
      }
    }

    return instance;
  }

  /**
   * Tear down all resource instances owned by a dynamically-spawned context,
   * cascading depth-first through its children. Removes entries from both
   * ctx.resourceInstances and the Kernel-level resourceInstances map, and
   * emits Teardown events (matching the behaviour of teardownResource()).
   */
  async teardownContext(ctx: EvaluationContext): Promise<void> {
    for (const child of [...ctx.children].reverse()) {
      await this.teardownContext(child);
    }
    const entries = [...ctx.resourceInstances.entries()].reverse();
    for (const [key, { resource, instance }] of entries) {
      if (instance.teardown) await instance.teardown();
      await this.eventBus.emit(`${resource.kind}.${resource.metadata.name}.Teardown`, {
        resource: { kind: resource.kind, name: resource.metadata.name },
      });
      // this.resourceInstances.delete(key);
      ctx.resourceInstances.delete(key);
      this.resourceEventBuses.delete(key);
    }
  }

  // getResourcesByKind(kind: string): RuntimeResource[] {
  //   const resources: RuntimeResource[] = [];
  //   for (const entry of this.resourceInstances.values()) {
  //     if (entry.resource.kind === kind) {
  //       resources.push(entry.instance as any);
  //     }
  //   }
  //   return resources;
  // }

  // getResourceByName(declaringModule: string, alias: string, name: string): RuntimeResource | null {
  //   const realModule = this.moduleContextRegistry.resolveAlias(declaringModule, alias) ?? alias;
  //   for (const { resource, instance } of this.resourceInstances.values()) {
  //     if (resource.metadata.module === realModule && resource.metadata.name === name) {
  //       return instance as RuntimeResource;
  //     }
  //   }
  //   return null;
  // }

  /**
   * Returns the unique set of local file paths from which resources were loaded.
   * HTTP/HTTPS sources are excluded — they cannot be watched on disk.
   */
  // getSourceFiles(): string[] {
  //   const seen = new Set<string>();
  //   for (const { resource } of this.resourceInstances.values()) {
  //     const src = resource.metadata.source;
  //     if (src && !src.startsWith("http://") && !src.startsWith("https://")) {
  //       seen.add(src);
  //     }
  //   }
  //   return Array.from(seen);
  // }

  /**
   * Reload all resources that were loaded from the given source file.
   * Safe order: parse first → if parse succeeds, tear down old → init new → run new only.
   */
  // async reloadSource(sourcePath: string): Promise<void> {
  //   // Parse first — bail before touching running resources if the file is invalid
  //   const newManifests = await this.loader.loadManifest(sourcePath, `file://${process.cwd()}/`, {
  //     env: process.env,
  //   });

  //   // Collect keys of resources loaded from this source (in insertion order)
  //   const keysFromSource: string[] = [];
  //   for (const [key, { resource }] of this.resourceInstances.entries()) {
  //     if (resource.metadata.source === sourcePath) {
  //       keysFromSource.push(key);
  //     }
  //   }
  //   // Tear down in reverse order (children first via cascade)
  //   for (const key of [...keysFromSource].reverse()) {
  //     const entry = this.resourceInstances.get(key);
  //     if (!entry) continue; // already removed by a cascade
  //     await this.teardownResource(
  //       entry.resource.metadata.module,
  //       entry.resource.kind,
  //       entry.resource.metadata.name,
  //     );
  //   }

  //   for (const manifest of newManifests) {
  //     this.rootContext.registerManifest(manifest);
  //   }
  //   const keysBefore = new Set(this.resourceInstances.keys());
  //   await this.initializeResources();

  //   // Run only newly created instances (not all instances — avoids double-run)
  //   const newKeys = Array.from(this.resourceInstances.keys()).filter((k) => !keysBefore.has(k));
  //   for (const key of newKeys) {
  //     const entry = this.resourceInstances.get(key);
  //     if (entry?.instance.run) {
  //       await entry.instance.run();
  //     }
  //   }
  // }

  private getResourceKey(module: string, kind: string, name: string): string {
    if (!kind.includes(".")) {
      throw new Error(`Resource kind must include module prefix: ${kind}`);
    }
    return `${module}.${kind}.${name}`;
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
