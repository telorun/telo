import { ResourceContext, RuntimeEvent, RuntimeResource, isContextProvider } from "@telorun/sdk";
import * as path from "path";
import { BootContextRegistry } from "./boot-context-registry.js";
import { ControllerRegistry } from "./controller-registry.js";
import { EventStream } from "./event-stream.js";
import { EventBus } from "./events.js";
import { evaluateCel, expandValue, resolveManifestWithContext } from "./expressions.js";
import { Loader } from "./loader.js";
import { ResourceContextImpl } from "./resource-context.js";
import { SchemaValidator } from "./schema-valiator.js";
import {
  ControllerContext,
  Kernel as IKernel,
  ResourceDefinition,
  ResourceInstance,
  ResourceManifest,
  RuntimeError,
} from "./types.js";

/**
 * Kernel: Central orchestrator managing lifecycle and message bus
 * Handles resource loading, initialization, and execution through controllers
 */
export class Kernel implements IKernel {
  private loader: Loader = new Loader();
  // private manifests: ManifestRegistry = new ManifestRegistry();
  private initializationQueue: ResourceManifest[] = [];
  private controllers: ControllerRegistry = new ControllerRegistry();
  private eventBus: EventBus = new EventBus();
  private eventStream: EventStream = new EventStream();
  // private snapshotSerializer: SnapshotSerializer = new SnapshotSerializer();
  // private runtimeManifests: ResourceManifest[] | null = null;
  private resourceInstances: Map<
    string,
    { resource: ResourceManifest; instance: ResourceInstance }
  > = new Map();
  private resourceEventBuses: Map<string, EventBus> = new Map();
  private resourceChildren: Map<string, string[]> = new Map();
  private holdCount = 0;
  private idleResolvers: Array<() => void> = [];
  private _exitCode = 0;
  private bootContextRegistry = new BootContextRegistry();
  private readonly sharedSchemaValidator = new SchemaValidator();

  constructor() {
    this.setupEventStreaming();
  }

  /**
   * Register a resource dynamically during initialization
   */
  registerManifest(resource: ResourceManifest): void {
    this.initializationQueue.push(resource);
  }

  /**
   * Register a child resource and track the parent-child relationship for cascade teardown
   */
  registerChildManifest(parentKey: string, resource: ResourceManifest): void {
    this.initializationQueue.push(resource);
    const childKey = this.getResourceKey(
      resource.metadata.module,
      resource.kind,
      resource.metadata.name,
    );
    const children = this.resourceChildren.get(parentKey) ?? [];
    children.push(childKey);
    this.resourceChildren.set(parentKey, children);
  }

  /**
   * Tear down a single resource and cascade to its children first
   */
  async teardownResource(module: string, kind: string, name: string): Promise<void> {
    const key = this.getResourceKey(module, kind, name);
    // Cascade: tear down children in reverse registration order first
    const childKeys = this.resourceChildren.get(key) ?? [];
    for (const childKey of [...childKeys].reverse()) {
      const childEntry = this.resourceInstances.get(childKey);
      if (childEntry) {
        await this.teardownResource(
          childEntry.resource.metadata.module,
          childEntry.resource.kind,
          childEntry.resource.metadata.name,
        );
      }
    }
    this.resourceChildren.delete(key);
    // Tear down self
    const entry = this.resourceInstances.get(key);
    if (!entry) return;
    const { resource, instance } = entry;
    if (instance.teardown) {
      await instance.teardown();
    }
    await this.eventBus.emit(
      `${resource.metadata.module}.${resource.kind}.${resource.metadata.name}.Teardown`,
      { resource: { kind: resource.kind, name: resource.metadata.name } },
    );
    this.resourceInstances.delete(key);
    this.resourceEventBuses.delete(key);
  }

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

  isCapabilityRegistered(name: string): boolean {
    return this.controllers.isCapabilityRegistered(name);
  }

  getCapabilitySchema(name: string): Record<string, any> | null | undefined {
    return this.controllers.getCapabilitySchema(name);
  }

  /**
   * Load built-in Runtime definitions (e.g., Kernel.Module)
   */
  private async loadBuiltinDefinitions(): Promise<void> {
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
    const moduleSchema = await import("./controllers/module/module.json", {
      with: { type: "json" },
    });
    this.controllers.registerDefinition({
      kind: "Kernel.Definition",
      metadata: { name: "Module", module: "Kernel" },
      capabilities: ["template"],
      schema: moduleSchema,
    });
    this.controllers.registerController(
      "Kernel.Module",
      await import("./controllers/module/module-controller.js"),
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
    // Initialize built-in Runtime definitions first
    await this.loadBuiltinDefinitions();

    // Load built-in capability manifests before user configuration so that
    // capability resources are available in the first initialization pass
    const { fileURLToPath } = await import("url");
    const capabilitiesDir = fileURLToPath(new URL("./capabilities/", import.meta.url));
    const capabilityManifests = await this.loader.loadDirectory(capabilitiesDir);

    // Load runtime configuration
    const userManifests = await this.loader.loadManifest(
      runtimeYamlPath,
      `file://${process.cwd()}/`,
    );
    this.initializationQueue = [...capabilityManifests, ...userManifests];
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
      const controller = await this.controllers.getController(kind);
      if (controller?.register) {
        await controller.register(this.createControllerContext(`controller:${kind}`));
      }
    }

    // Initialize resources
    try {
      await this.initializeResources();
      await this.eventBus.emit("Kernel.Initialized", {});
      await this.eventBus.emit("Kernel.Starting", {});
      await this.runInstances();
      await this.eventBus.emit("Kernel.Started", {});
      await this.waitForIdle();
    } finally {
      await this.eventBus.emit("Kernel.Stopping", {});
      await this.teardownResources();
      await this.eventBus.emit("Kernel.Stopped", { exitCode: this._exitCode });
    }
  }

  async runInstances(): Promise<void> {
    for (const entry of this.resourceInstances.values()) {
      const { resource, instance } = entry;
      if (instance.run) {
        await instance.run();
      }
    }
  }

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

  hasResourceInstances(): boolean {
    return this.resourceInstances.size > 0;
  }

  async teardownResources(): Promise<void> {
    const keys = Array.from(this.resourceInstances.keys()).reverse();
    for (const key of keys) {
      const entry = this.resourceInstances.get(key);
      if (!entry) continue; // already removed by a cascade
      await this.teardownResource(
        entry.resource.metadata.module,
        entry.resource.kind,
        entry.resource.metadata.name,
      );
    }
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
      evaluateCel: (expression: string, context: Record<string, any>) =>
        evaluateCel(expression, context),
      expandValue: (value: any, context: Record<string, any>) => expandValue(value, context),
      requestExit: (code: number) => this.requestExit(code),
    };
  }

  private createResourceContext(resource: ResourceManifest): ResourceContext {
    const key = this.getResourceKey(
      resource.metadata.module,
      resource.kind,
      resource.metadata.name,
    );
    return new ResourceContextImpl(this, resource.metadata, this.sharedSchemaValidator, key);
  }

  getResourcesByKind(kind: string): RuntimeResource[] {
    const resources: RuntimeResource[] = [];
    for (const entry of this.resourceInstances.values()) {
      if (entry.resource.kind === kind) {
        resources.push(entry.instance as any);
      }
    }
    return resources;
  }

  getResourceByName(module: string, kind: string, name: string): RuntimeResource | null {
    const key = this.getResourceKey(module, kind, name);
    const entry = this.resourceInstances.get(key);
    if (entry) {
      return entry.instance as any;
    }
    return null;
  }

  /**
   * Returns the unique set of local file paths from which resources were loaded.
   * HTTP/HTTPS sources are excluded — they cannot be watched on disk.
   */
  getSourceFiles(): string[] {
    const seen = new Set<string>();
    for (const { resource } of this.resourceInstances.values()) {
      const src = resource.metadata.source;
      if (src && !src.startsWith("http://") && !src.startsWith("https://")) {
        seen.add(src);
      }
    }
    return Array.from(seen);
  }

  /**
   * Reload all resources that were loaded from the given source file.
   * Safe order: parse first → if parse succeeds, tear down old → init new → run new only.
   */
  async reloadSource(sourcePath: string): Promise<void> {
    // Parse first — bail before touching running resources if the file is invalid
    const newManifests = await this.loader.loadManifest(sourcePath, `file://${process.cwd()}/`);

    // Collect keys of resources loaded from this source (in insertion order)
    const keysFromSource: string[] = [];
    for (const [key, { resource }] of this.resourceInstances.entries()) {
      if (resource.metadata.source === sourcePath) {
        keysFromSource.push(key);
      }
    }
    // Tear down in reverse order (children first via cascade)
    for (const key of [...keysFromSource].reverse()) {
      const entry = this.resourceInstances.get(key);
      if (!entry) continue; // already removed by a cascade
      await this.teardownResource(
        entry.resource.metadata.module,
        entry.resource.kind,
        entry.resource.metadata.name,
      );
    }

    // Queue new manifests and initialize them
    for (const manifest of newManifests) {
      this.initializationQueue.push(manifest);
    }
    const keysBefore = new Set(this.resourceInstances.keys());
    await this.initializeResources();

    // Run only newly created instances (not all instances — avoids double-run)
    const newKeys = Array.from(this.resourceInstances.keys()).filter((k) => !keysBefore.has(k));
    for (const key of newKeys) {
      const entry = this.resourceInstances.get(key);
      if (entry?.instance.run) {
        await entry.instance.run();
      }
    }
  }

  private async initializeResources(): Promise<void> {
    /**
     * Step 4: Multi-Pass Controller Discovery Loop (Max 10 Passes)
     * Loop up to 10 passes to discover controllers and create resource instances.
     * Each pass removes handled resources from the list, making subsequent passes faster.
     */

    // Collect all resources from registry as a list

    let passNumber = 1;
    const MAX_PASSES = 10;
    const createdResources: Array<{
      kind: string;
      resource: ResourceManifest;
      instance: ResourceInstance;
    }> = [];
    let handledThisPass: Array<{
      kind: string;
      resource: ResourceManifest;
    }> = [];
    // Track latest error for each resource
    const resourceErrors: Map<string, string> = new Map();
    // Multi-pass loop
    do {
      handledThisPass = [];

      for (const resource of this.initializationQueue) {
        const kind = resource.kind;
        const key = this.getResourceKey(resource.metadata.module, kind, resource.metadata.name);
        const resourceId = `${kind}:${resource.metadata.name}`;

        // Skip if already created
        if (this.resourceInstances.has(key)) {
          continue;
        }

        const controller = this.controllers.getControllerOrUndefined(kind);

        if (!controller) {
          // No controller and no definition - track error and skip for now
          resourceErrors.set(resourceId, `No controller registered for kind: ${kind}`);
          continue;
        }

        if (!controller.create) {
          // Controller exists but has no create method, skip
          throw new RuntimeError(
            "ERR_CONTROLLER_INVALID",
            `Controller for ${kind} does not implement create method`,
          );
        }

        try {
          if (!controller.schema || !controller.schema.type) {
            throw new Error(`No schema defined for ${kind} controller`);
          }

          // AOT: resolve static boot-context expressions before schema validation
          // and controller creation. This is a no-op until at least one provider
          // has registered its context.
          let resolvedResource = resource;
          if (this.bootContextRegistry.hasProviders()) {
            const bootContext = this.bootContextRegistry.buildContext(
              resource.kind,
              resource.metadata.name,
              resource,
            );
            resolvedResource = resolveManifestWithContext(resource, bootContext);
          }

          this.sharedSchemaValidator.compile(controller.schema).validate(resolvedResource);
          // Create resource instance using the resolved manifest
          const instance = await controller.create(
            resolvedResource,
            this.createResourceContext(resolvedResource),
          );

          if (instance) {
            if (instance.init) {
              await instance.init(this.createResourceContext(resolvedResource));
            }
            // Register ContextProvider after init() — init may populate context state
            if (isContextProvider(instance)) {
              this.bootContextRegistry.register(
                resource.kind,
                resource.metadata.name,
                resource.metadata.module,
                resource.grants as string[] | undefined,
                instance.provideContext(),
              );
            }
            this.resourceInstances.set(key, { resource: resolvedResource, instance });
            createdResources.push({ kind, resource: resolvedResource, instance });
            handledThisPass.push({ kind, resource });
            resourceErrors.delete(resourceId);
          }
          this.initializationQueue = this.initializationQueue.filter(
            (r) =>
              r.metadata.module !== resource.metadata.module ||
              r.kind !== resource.kind ||
              r.metadata.name !== resource.metadata.name,
          );
        } catch (error) {
          // Security violations are fatal — never retry
          if (error instanceof RuntimeError && error.code === "ERR_VISIBILITY_DENIED") {
            throw error;
          }
          // Creation failed - track latest error and retry later
          resourceErrors.set(
            resourceId,
            error instanceof Error ? (error.stack ?? error.message) : String(error),
          );
        }
      }

      passNumber++;
    } while (passNumber <= MAX_PASSES && handledThisPass.length > 0);

    const unhandledResources: Map<string, string> = new Map();

    // After loop, collect any resources that were never handled
    for (const { kind, metadata } of this.initializationQueue) {
      const key = this.getResourceKey(metadata.module, kind, metadata.name);
      if (!this.resourceInstances.has(key)) {
        const resourceId = `${kind}:${metadata.name}`;
        const errorMessage = resourceErrors.get(resourceId) || "Unknown error";
        unhandledResources.set(resourceId, errorMessage);
      }
    }

    // After all passes complete, check for unhandled resources
    if (unhandledResources.size > 0) {
      const unhandledList = Array.from(unhandledResources.entries())
        .reverse() // Most relevant errors (root causes) are last in the list, so reverse to show them first
        .map(([resource, error]) => `- ${resource}: ${error}`)
        .join("\n");
      throw new RuntimeError(
        "ERR_CONTROLLER_NOT_FOUND",
        `Unable to process resources:\n\n${unhandledList}`,
      );
    }
  }

  // /**
  //  * Execute - Dispatch execution request to appropriate controller
  //  */
  // async execute(urn: string, input: any, ctx?: any): Promise<any> {
  //   const [kind, name] = this.parseUrn(urn);

  //   // Lookup resource
  //   const resource = this.manifests.get(kind, name);
  //   if (!resource) {
  //     throw new RuntimeError("ERR_RESOURCE_NOT_FOUND", `Resource not found: ${urn}`);
  //   }

  //   // Find controller for this Kind
  //   const controller = await this.controllers.getController(kind);
  //   if (!controller) {
  //     throw new RuntimeError(
  //       "ERR_CONTROLLER_NOT_FOUND",
  //       `No controller registered for Kind: ${kind}`,
  //     );
  //   }

  //   // Create execution context with recursive execute capability
  //   const execContext: ExecContext = {
  //     execute: (nestedUrn: string, nestedInput: any) => this.execute(nestedUrn, nestedInput, ctx),
  //     ...ctx,
  //   };

  //   try {
  //     await this.eventBus.emit(`${name}.ExecutionStarted`, { urn });
  //     const result = await controller.execute?.(name, input, {
  //       ...execContext,
  //       resource,
  //     });
  //     await this.eventBus.emit(`${name}.ExecutionCompleted`, { urn });
  //     return result;
  //   } catch (error) {
  //     await this.eventBus.emit(`${name}.ExecutionFailed`, {
  //       urn,
  //       error: error instanceof Error ? error.message : String(error),
  //     });
  //     throw new RuntimeError(
  //       "ERR_EXECUTION_FAILED",
  //       `Execution failed for ${urn}: ${error instanceof Error ? error.message : String(error)}`,
  //     );
  //   }
  // }

  // private parseUrn(urn: string): [string, string] {
  //   const separator = urn.lastIndexOf(".");
  //   if (separator <= 0 || separator === urn.length - 1) {
  //     throw new Error(
  //       `Invalid URN format: ${urn}. Expected "Kind.Name" where Kind can include dots`,
  //     );
  //   }
  //   const kind = urn.slice(0, separator);
  //   const name = urn.slice(separator + 1);
  //   return [kind, name];
  // }

  async invoke(module: string, kind: string, name: string, ...args: any[]): Promise<any> {
    const instance: any = this.getResourceByName(module, kind, name);
    if (!instance) {
      throw new RuntimeError(
        "ERR_RESOURCE_NOT_FOUND",
        `Resource not found for invocation: ${module}.${kind}.${name}`,
      );
    }
    if (typeof instance !== "object" || typeof instance["invoke"] !== "function") {
      throw new RuntimeError(
        "ERR_RESOURCE_NOT_INVOKABLE",
        `Resource ${kind}.${name} does not have an invoke method`,
      );
    }
    const outputs = await instance["invoke"](...args);
    this.emitRuntimeEvent(`${module}.${kind}.${name}.Invoked`, {
      outputs,
    });
    return outputs;
  }

  private getResourceKey(module: string, kind: string, name: string): string {
    if (!kind.includes(".")) {
      throw new Error(`Resource kind must include module prefix: ${kind}`);
    }
    return `${module}.${kind}.${name}`;
  }

  // private assertResourceEventAllowed(event: string): void {
  //   const parts = event.split(".");
  //   const leaf = parts[parts.length - 1];
  //   if (leaf === "Initialized" || leaf === "Teardown") {
  //     throw new Error(`Resource events cannot use reserved lifecycle event: ${leaf}`);
  //   }
  // }

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
   * Take a snapshot of current runtime state
   */
  // async takeSnapshot(filePath?: string) {
  //   return this.snapshotSerializer.takeSnapshot(
  //     this.manifests.getAll(),
  //     this.resourceInstances,
  //     filePath,
  //   );
  // }

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
