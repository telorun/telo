import {
  isCompiledValue,
  isInvokeError,
  resourceKey,
  type EvaluationContext as IEvaluationContext,
  type EmitEvent,
  type InstanceFactory,
  type LifecycleState,
  type PreInitHook,
  type ResourceDefinition,
  type ResourceInstance,
  type ResourceManifest,
  type RuntimeDiagnostic,
  type ScopeContext,
  type ScopeHandle,
} from "@telorun/sdk";
import { RuntimeError } from "@telorun/sdk";

export { resourceKey };

/**
 * Base class for all evaluation contexts. Owns template
 * expansion, secrets redaction, and the generic resource lifecycle tree.
 *
 * Every EvaluationContext node can:
 *   - Hold its own resource instances (resourceInstances)
 *   - Queue resources for initialization (pendingResources)
 *   - Spawn child contexts (spawnChild) forming a lifecycle tree
 *   - Run a multi-pass initialization loop (initializeResources)
 *   - Cascade teardown depth-first through the tree (teardownResources)
 */
export class EvaluationContext implements IEvaluationContext {
  readonly id = Math.random().toString(16).slice(2, 8);
  protected _context: Record<string, unknown>;
  protected _secretValues: Set<string>;
  protected _createInstance: InstanceFactory;
  readonly emit: EmitEvent;

  /** Position in the lifecycle tree. */
  parent: IEvaluationContext | undefined = undefined;
  readonly children: IEvaluationContext[] = [];

  /** Current lifecycle state of this context node. */
  state: LifecycleState = "Pending";

  /** Resource instances owned by this context node, keyed by resourceKey(). */
  readonly resourceInstances = new Map<
    string,
    { resource: ResourceManifest; instance: ResourceInstance }
  >();

  /** Resources that have been created but not yet initialized (between phases). */
  protected readonly createdInstances = new Map<
    string,
    { resource: ResourceManifest; instance: ResourceInstance; ctx: any }
  >();

  /** Resources queued for initialization on this context node. */
  private pendingResources: ResourceManifest[] = [];

  /**
   * Optional hook called between create() and init() for each resource.
   * Set by the kernel to inject live instances into reference fields.
   */
  preInitHook?: PreInitHook;

  /**
   * Optional definition lookup used by invoke()/invokeResolved() to check
   * thrown InvokeError.code against the declared throw union (rule 9).
   * Set by the kernel; propagates through spawnChild() like preInitHook.
   */
  getDefinition?: (kind: string) => ResourceDefinition | undefined;

  constructor(
    readonly source: string,
    context: Record<string, unknown>,
    createInstance: InstanceFactory = async () => null,
    secretValues: Set<string>,
    emit: EmitEvent,
  ) {
    this._context = context;
    this._createInstance = createInstance;
    this._secretValues = secretValues ?? new Set();
    this.emit = emit;
  }

  get createInstance(): InstanceFactory {
    return this._createInstance;
  }

  /** Called after init() when a resource snapshot is available. Overridden by ModuleContext. */
  protected onResourceSnapshotted(_name: string, _snap: Record<string, unknown>): void {}

  get context(): Record<string, unknown> {
    return this._context;
  }

  get secretValues(): Set<string> {
    return this._secretValues;
  }

  /**
   * Reorder pending resources to match the given name sequence (topo order from Phase 4).
   * Resources not present in `names` are left at the end in their original order.
   * Call before initializeResources() so the create/init sub-phases run in dependency order,
   * guaranteeing that Phase 5 injection always finds initialized dependencies.
   */
  setInitOrder(names: string[]): void {
    const rank = new Map(names.map((n, i) => [n, i]));
    this.pendingResources.sort((a, b) => {
      const ra = rank.get(a.metadata.name as string) ?? Infinity;
      const rb = rank.get(b.metadata.name as string) ?? Infinity;
      return ra - rb;
    });
  }

  /**
   * Queue a resource manifest for initialization on this context.
   */
  hasManifest(name: string): boolean {
    return (
      this.resourceInstances.has(name) ||
      this.createdInstances.has(name) ||
      this.pendingResources.some((r) => r.metadata.name === name)
    );
  }

  registerManifest(resource: ResourceManifest): void {
    if (!resource.metadata) {
      resource.metadata = { name: `__unnamed_${Math.random().toString(16).slice(2, 8)}` };
    }
    const name = resource.metadata.name;
    if (this.hasManifest(name)) {
      throw new RuntimeError("ERR_DUPLICATE_RESOURCE", `Resource '${name}' is already registered`);
    }
    this.pendingResources.push(resource);
  }

  /**
   * Attach a child context to this node. The child's parent is set to this
   * context and the child is registered under the given name.
   */
  spawnChild<T extends IEvaluationContext>(child: T): T {
    child.parent = this;
    this.children.push(child);
    // Propagate injection hook so all child contexts (module imports, scopes) participate
    // in Phase 5 injection. createScopeHandle overrides this with an extended version.
    if (this.preInitHook && !child.preInitHook) {
      child.preInitHook = this.preInitHook;
    }
    if (this.getDefinition && !child.getDefinition) {
      child.getDefinition = this.getDefinition;
    }
    return child;
  }

  /**
   * Interleaved create/init loop.
   *
   * Each pass has two sub-phases run back-to-back:
   *   1. Create sub-phase: call controller.create() for each pending resource that
   *      hasn't been created yet. Successful results go into createdInstances.
   *   2. Init sub-phase: call instance.init(ctx) for each created-but-not-inited
   *      resource. Successful results go into resourceInstances.
   *
   * Interleaving is necessary because some resources' create() depends on effects
   * produced by other resources' init() (e.g. Telo.Import.init() runs
   * child.initializeResources() which registers controllers needed by sibling
   * resources' create()). Running both sub-phases each pass lets those effects
   * propagate before the next create attempt.
   *
   * Each resource is created at most once and inited at most once.
   * ERR_VISIBILITY_DENIED and ERR_FATAL are re-thrown immediately.
   * All other errors are tracked and retried until no progress is made.
   */
  async initializeResources(): Promise<void> {
    const MAX_PASSES = 10;
    const errors = new Map<string, string>();

    let pass = 1;
    do {
      let progress = false;

      // Create sub-phase
      for (const resource of [...this.pendingResources]) {
        const name = resource.metadata.name;
        if (this.createdInstances.has(name)) continue;
        try {
          // const expanded = this.expand(resource) as ResourceManifest;
          // FIXME: Cannot expand it for all resources, needs to be selective
          const created = await this._createInstance(this, resource);
          if (created) {
            this.createdInstances.set(name, {
              resource,
              instance: created.instance,
              ctx: created.ctx,
            });
            const idx = this.pendingResources.findIndex((m) => m.metadata.name === name);
            if (idx >= 0) this.pendingResources.splice(idx, 1);
            errors.delete(name);
            progress = true;
          }
        } catch (error) {
          if (error instanceof RuntimeError && (error.code === "ERR_VISIBILITY_DENIED" || error.code === "ERR_FATAL")) throw error;
          errors.set(name, error instanceof Error ? error.message : String(error));
        }
      }

      // Init sub-phase
      for (const [name, { resource, instance, ctx }] of [...this.createdInstances]) {
        if (this.resourceInstances.has(name)) continue;
        try {
          if (this.preInitHook) {
            this.preInitHook(resource, (n) => this.resourceInstances.get(n)?.instance);
          }
          if (instance.init) await instance.init(ctx);
          if (instance.snapshot) {
            const snap = await Promise.resolve(instance.snapshot()).catch(() => ({}));
            this.onResourceSnapshotted(name, (snap as Record<string, unknown>) ?? {});
          }
          this.resourceInstances.set(name, { resource, instance });
          this.createdInstances.delete(name);
          errors.delete(name);
          progress = true;
        } catch (error) {
          if (error instanceof RuntimeError && (error.code === "ERR_VISIBILITY_DENIED" || error.code === "ERR_FATAL")) throw error;
          errors.set(name, error instanceof Error ? error.message : String(error));
        }
      }

      pass++;
      if (!progress) break;
    } while (pass <= MAX_PASSES);

    if (this.pendingResources.length > 0 || this.createdInstances.size > 0) {
      const diagnostics: RuntimeDiagnostic[] = [
        ...this.pendingResources.map((r) => ({
          resource: r.metadata.name,
          message: errors.get(r.metadata.name) ?? "Unknown error",
        })),
        ...[...this.createdInstances.keys()].map((name) => ({
          resource: name,
          message: errors.get(name) ?? "Unknown error",
        })),
      ];
      const details = diagnostics
        .map((d) => `  ${d.resource}: ${d.message}`)
        .join("\n");
      throw new RuntimeError(
        "ERR_RESOURCE_INITIALIZATION_FAILED",
        `Unable to process resources:\n${details}`,
        diagnostics,
      );
    }

    this.state = "Initialized";
  }

  withManifests<T>(manifests: any[], fn: () => T): T {
    const child = this.spawnChild(
      new EvaluationContext(
        this.source,
        this._context,
        this._createInstance,
        this._secretValues,
        this.emit,
      ),
    );
    try {
      for (const manifest of manifests) {
        child.registerManifest(manifest);
      }
      return fn();
    } finally {
      // Tear down child context and its resources immediately after fn() completes.
      // Note that this does NOT emit Kernel-level events (e.g. Teardown events) —
      // they remain the Kernel's responsibility.
      child.teardownResources();
    }
  }

  /**
   * Returns a ScopeHandle that initializes `manifests` in a fresh child context each time
   * `run()` is called, executes the callback with a ScopeContext, and tears down when done.
   *
   * The child inherits the parent's preInitHook (if any), extended so that `getInstance`
   * also checks the parent's already-initialized singleton instances. This lets scoped
   * resources hold x-telo-ref slots pointing to outer resources — those deps are already
   * live when the scope opens.
   */
  createScopeHandle(manifests: ResourceManifest[]): ScopeHandle {
    const parent = this;
    return {
      async run<T>(fn: (scope: ScopeContext) => Promise<T>): Promise<T> {
        const child = parent.spawnChild(
          new EvaluationContext(
            parent.source,
            parent._context,
            parent._createInstance,
            parent._secretValues,
            parent.emit,
          ),
        );

        // Propagate injection hook: extend getInstance to also resolve parent singleton instances.
        if (parent.preInitHook) {
          const parentHook = parent.preInitHook;
          child.preInitHook = (resource, childGetInstance) => {
            parentHook(
              resource,
              (name) => childGetInstance(name) ?? parent.resourceInstances.get(name)?.instance,
            );
          };
        }

        try {
          for (const manifest of manifests) {
            child.registerManifest(manifest);
          }
          await child.initializeResources();
          const scope: ScopeContext = {
            getInstance(name: string): ResourceInstance {
              const childEntry = child.resourceInstances.get(name);
              if (childEntry) return childEntry.instance;
              const parentEntry = parent.resourceInstances.get(name);
              if (parentEntry) return parentEntry.instance;
              throw new RuntimeError(
                "ERR_SCOPE_RESOURCE_NOT_FOUND",
                `Resource '${name}' not found in scope or outer context. Available scoped: ${[...child.resourceInstances.keys()].join(", ")}`,
              );
            },
          };
          return await fn(scope);
        } finally {
          await child.teardownResources();
          const idx = parent.children.indexOf(child);
          if (idx >= 0) parent.children.splice(idx, 1);
        }
      },
    };
  }

  /**
   * Cascade teardown depth-first through the tree:
   *   1. Tear down child contexts in reverse registration order.
   *   2. Tear down own resource instances in reverse registration order,
   *      emitting a Teardown event for each via the injected emit callback.
   */
  async teardownResources(): Promise<void> {
    this.state = "Draining";
    for (const child of [...this.children].reverse()) {
      await child.teardownResources();
    }
    const entries = [...this.resourceInstances.entries()].reverse();
    for (const [key, { resource, instance }] of entries) {
      if (instance.teardown) await instance.teardown();
      await this.emit(`${resource.kind}.${resource.metadata.name}.Teardown`, {
        resource: { kind: resource.kind, name: resource.metadata.name },
      });
      this.resourceInstances.delete(key);
    }
    this.state = "Teardown";
  }

  transientChild(context: Record<string, any>): EvaluationContext {
    return new EvaluationContext(
      this.source,
      { ...this.context, ...context },
      this._createInstance,
      this._secretValues,
      this.emit,
    );
  }

  /**
   * Invoke a resource by kind and name within this context's resourceInstances.
   * Emits a scoped Invoked/InvokeRejected/InvokeFailed event via the injected
   * emit callback. The single emission point for invoke-level events — callers
   * holding an already-resolved instance should use invokeResolved() instead.
   */
  async invoke<TInputs>(kind: string, name: string, inputs: TInputs): Promise<any> {
    const entry = this.resourceInstances.get(name);

    if (!entry) {
      throw new RuntimeError(
        "ERR_RESOURCE_NOT_FOUND",
        `Resource not found for invocation: ${kind}.${name}. Available resources: ${[...this.resourceInstances.keys()].join(", ")}`,
      );
    }

    if (typeof entry.instance.invoke !== "function") {
      throw new RuntimeError(
        "ERR_RESOURCE_NOT_INVOKABLE",
        `Resource ${kind}.${name} does not have an invoke method`,
      );
    }

    return this.runInvoke(kind, name, entry.instance, inputs);
  }

  /**
   * Like invoke(), but the caller has already resolved the instance (e.g. the
   * scope path in Run.Sequence, or the live-injected Http.Api route handler).
   * Shares the single emission point so events fire exactly once per call
   * regardless of which path reached the instance.
   */
  async invokeResolved<TInputs>(
    kind: string,
    name: string,
    instance: ResourceInstance,
    inputs: TInputs,
  ): Promise<any> {
    if (typeof instance.invoke !== "function") {
      throw new RuntimeError(
        "ERR_RESOURCE_NOT_INVOKABLE",
        `Resource ${kind}.${name} does not have an invoke method`,
      );
    }
    return this.runInvoke(kind, name, instance, inputs);
  }

  private async runInvoke<TInputs>(
    kind: string,
    name: string,
    instance: ResourceInstance,
    inputs: TInputs,
  ): Promise<any> {
    try {
      const outputs = await (instance.invoke as (i: any) => any)(inputs as any);
      await this.emit(`${kind}.${name}.Invoked`, { outputs });
      return outputs;
    } catch (err) {
      if (isInvokeError(err)) {
        const payload = { code: err.code, message: err.message, data: err.data };
        await this.emit(`${kind}.${name}.InvokeRejected`, payload);
        const declaredCodes = this.getDeclaredThrowCodes(kind);
        if (declaredCodes && !declaredCodes.has(err.code)) {
          await this.emit(`${kind}.${name}.InvokeRejected.Undeclared`, payload);
        }
      } else if (err instanceof Error) {
        await this.emit(`${kind}.${name}.InvokeFailed`, {
          name: err.name,
          message: err.message,
        });
      } else {
        await this.emit(`${kind}.${name}.InvokeFailed`, {
          name: "UnknownError",
          message: String(err),
        });
      }
      throw err;
    }
  }

  private getDeclaredThrowCodes(kind: string): Set<string> | null {
    if (!this.getDefinition) return null;
    const def = this.getDefinition(kind);
    if (!def) return null;
    const throws = def.throws;
    if (!throws) return new Set();
    // inherit / passthrough unions are dynamic — resolved statically by the
    // analyzer, not re-derivable here without a manifest-wide traversal. Skip
    // the rule 9 check rather than mis-report every propagated code as
    // undeclared at runtime.
    if (throws.inherit || throws.passthrough) return null;
    const codes = throws.codes;
    if (!codes) return new Set();
    return new Set(Object.keys(codes));
  }

  async run(name: string): Promise<void> {
    const entry = this.resourceInstances.get(name);
    if (entry && typeof entry.instance.run === "function") {
      return entry.instance.run();
    }
    throw new RuntimeError(
      "ERR_RESOURCE_NOT_RUNNABLE",
      `Resource ${name} is not runnable or not found. Available resources: ${[...this.resourceInstances.keys()].join(", ")}`,
    );
  }

  /**
   * Expand a value that may contain precompiled ${{ }} templates.
   * Works recursively over CompiledValues, arrays, and objects.
   */
  expand(value: unknown): unknown {
    if (isCompiledValue(value)) {
      try {
        return value.call(this._context);
      } catch (error) {
        const expr = value.source ? `\${{ ${value.source} }}` : "unknown expression";
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`Expression ${expr} failed: ${msg}`);
      }
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.expand(entry));
    }
    if (value !== null && typeof value === "object") {
      const resolved: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        resolved[key] = this.expand(entry);
      }
      return resolved;
    }
    return value;
  }

  /**
   * Expand a value using this context merged with additional properties.
   * Equivalent to merge(extraContext).expand(value) without allocating a context object.
   */
  expandWith(value: unknown, extraContext: Record<string, unknown>): unknown {
    const saved = this._context;
    this._context = Object.assign(Object.create(null), saved, extraContext) as Record<
      string,
      unknown
    >;
    try {
      return this.expand(value);
    } finally {
      this._context = saved;
    }
  }

/**
   * Expand specific dot-paths within an object. '**' expands the entire object.
   * Paths listed in excludePaths are left untouched (runtime takes precedence).
   * Always throws if an expression cannot be resolved.
   */
  expandPaths(
    value: Record<string, unknown>,
    paths: string[],
    excludePaths: string[] = [],
  ): Record<string, unknown> {
    if (paths.includes("**")) {
      const result: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value)) {
        result[key] = isExcluded(key, excludePaths) ? v : this.expand(v);
      }
      return result;
    }
    const result = { ...value };
    for (const path of paths) {
      if (isExcluded(path, excludePaths)) continue;
      const parts = path.split(".");
      const current = getNestedValue(result, parts);
      if (current !== undefined) {
        setNestedValue(result, parts, this.expand(current));
      }
    }
    return result;
  }
}

function isExcluded(path: string, excludePaths: string[]): boolean {
  return excludePaths.some(
    (ep) => ep === path || ep === "**" || path.startsWith(ep + ".") || ep.startsWith(path + "."),
  );
}

function getNestedValue(obj: Record<string, unknown>, parts: string[]): unknown {
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, parts: string[], value: unknown): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = current[parts[i]];
    if (next === null || typeof next !== "object") return;
    current = next as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}
