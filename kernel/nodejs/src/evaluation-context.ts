import { AsyncLocalStorage } from "node:async_hooks";
import {
  isCompiledValue,
  isInvokeError,
  isCancellationError,
  resourceKey,
  UNCANCELLABLE_CONTEXT,
  type EvaluationContext as IEvaluationContext,
  type EmitEvent,
  type InstanceFactory,
  type InvokeContext,
  type LifecycleState,
  type OpenSpan,
  type OpenSpanOptions,
  type PreInitHook,
  type ResourceDefinition,
  type ResourceInstance,
  type ResourceManifest,
  type RuntimeDiagnostic,
  type ScopeContext,
  type ScopeHandle,
  type Tracer,
} from "@telorun/sdk";
import { RuntimeError } from "@telorun/sdk";

export { resourceKey };

/** An edge in the resource dependency graph: a resolved `!ref` target. */
type ResourceRef = { kind: string; name: string; alias?: string };

/** A pure resolved reference is a `{ kind, name, alias? }` object and nothing
 *  else — the shape `resolveRefSentinels` produces (Phase 2.5). An inline
 *  definition (`{ kind, ...config }`) carries extra keys and is its own node, so
 *  it is not an edge here; a live `ResourceInstance` (injected at Phase 5) has
 *  methods, never this exact key set. */
function isResolvedRef(value: unknown): value is ResourceRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.kind !== "string" || typeof v.name !== "string") return false;
  return Object.keys(v).every((k) => k === "kind" || k === "name" || k === "alias");
}

/**
 * Walk a resource manifest's config and collect every resolved `{kind, name,
 * alias?}` reference it points at — the outbound edges for the dependency graph.
 * Called at create time, before Phase-5 injection swaps refs for live instances,
 * so the targets are still inspectable plain objects (and there are no instance
 * cycles to guard against). `metadata` is skipped (it holds the resource's own
 * identity, never refs); ref leaves are not descended into. Deduped by alias+name.
 */
function collectResourceRefs(resource: ResourceManifest): ResourceRef[] {
  const found = new Map<string, ResourceRef>();
  const visit = (value: unknown): void => {
    if (isResolvedRef(value)) {
      const key = `${value.alias ?? ""}::${value.name}`;
      if (!found.has(key)) found.set(key, { kind: value.kind, name: value.name, ...(value.alias ? { alias: value.alias } : {}) });
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k === "metadata") continue;
        visit(v);
      }
    }
  };
  for (const [k, v] of Object.entries(resource as Record<string, unknown>)) {
    if (k === "kind" || k === "metadata") continue;
    visit(v);
  }
  return [...found.values()];
}

/**
 * Kernel-internal propagation of the current invocation tree's cancellation
 * scope. NEVER the controller-facing contract — controllers always receive the
 * token as the explicit `InvokeContext` argument. This store exists only so the
 * kernel's own `invoke`/`invokeResolved` can discover which token to forward
 * when a composing controller re-invokes without threading it by hand.
 */
const cancellationStore = new AsyncLocalStorage<InvokeContext>();

type Walker = (ctx: Record<string, unknown>) => unknown;

/** Compile a manifest subtree into a tightly-bound walker closure. The returned
 *  function takes an activation object and rebuilds a fresh container of the
 *  same shape with all `${{ }}` CompiledValues evaluated against the activation.
 *  Per-call overhead is one closure invocation per node — no isCompiledValue /
 *  Array.isArray / typeof / Object.entries checks at runtime. */
function compileWalker(value: unknown): Walker {
  if (isCompiledValue(value)) {
    const compiled = value;
    return (ctx) => {
      try {
        return compiled.call(ctx);
      } catch (error) {
        const expr = compiled.source ? `\${{ ${compiled.source} }}` : "unknown expression";
        const msg = error instanceof Error ? error.message : String(error);
        const hint = compiled.source ? describeFailedAccess(compiled.source, ctx, msg) : null;
        const suffix = hint ? `\n  ${hint}` : "";
        throw new Error(`Expression ${expr} failed: ${msg}${suffix}`);
      }
    };
  }
  if (Array.isArray(value)) {
    const childWalkers = value.map(compileWalker);
    const n = childWalkers.length;
    return (ctx) => {
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = childWalkers[i]!(ctx);
      return out;
    };
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => [k, compileWalker(v)] as const,
    );
    const n = entries.length;
    return (ctx) => {
      const out: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) {
        const [k, fn] = entries[i]!;
        out[k] = fn(ctx);
      }
      return out;
    };
  }
  return () => value;
}

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

  /**
   * Per-kernel invocation tracer. Set by the kernel on the root context and
   * propagated through spawnChild(); gates invocation-id minting in runInvoke().
   */
  tracer?: Tracer;

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
      resource.metadata = { name: `Unnamed${Math.random().toString(16).slice(2, 8)}` };
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
    if (this.tracer && !child.tracer) {
      child.tracer = this.tracer;
    }
    return child;
  }

  /** Spawn a fresh child context attached to this node — the isolated scope a
   *  templated definition registers its `resources:` into. Rooting it on the
   *  context that DEFINED the template (not the consumer that instantiated the
   *  kind) is what makes the template's internal kind aliases and `!ref`s
   *  resolve against the defining library's imports. Local sibling refs resolve
   *  in the child; a cross-module `!ref Alias.name` delegates to this context's
   *  imports (a plain child resolves none of its own). */
  spawnChildContext(): EvaluationContext {
    const child = new EvaluationContext(
      this.source,
      this.context,
      this._createInstance,
      this._secretValues,
      this.emit,
    );
    child.resolveImportedInstance = (alias, name) => this.resolveImportedInstance(alias, name);
    return this.spawnChild(child);
  }

  /**
   * Resolve a cross-module exported instance (`!ref Alias.name`) to its live instance.
   * Overridable hook: the base context has no imports, so it returns undefined; ModuleContext
   * overrides it to route into the named import's child context. Declared here so the
   * injection / scope closures in this base class can call it without downcasting.
   */
  resolveImportedInstance(alias: string, name: string): ResourceInstance | undefined {
    return undefined;
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
    const errors = new Map<string, { message: string; code?: string; details?: string }>();

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
              resource: created.resource,
              instance: created.instance,
              ctx: created.ctx,
            });
            const idx = this.pendingResources.findIndex((m) => m.metadata.name === name);
            if (idx >= 0) this.pendingResources.splice(idx, 1);
            errors.delete(name);
            progress = true;
            await this.emit(`${created.resource.kind}.${created.resource.metadata.name}.Created`, {
              resource: {
                kind: created.resource.kind,
                name: created.resource.metadata.name,
                module: created.resource.metadata.module,
              },
              dependencies: collectResourceRefs(created.resource),
            });
          }
        } catch (error) {
          if (error instanceof RuntimeError && (error.code === "ERR_VISIBILITY_DENIED" || error.code === "ERR_FATAL")) throw error;
          errors.set(name, formatErrorForDiagnostic(error));
        }
      }

      // Init sub-phase
      for (const [name, { resource, instance, ctx }] of [...this.createdInstances]) {
        if (this.resourceInstances.has(name)) continue;
        try {
          if (this.preInitHook) {
            this.preInitHook(
              resource,
              (n, alias) =>
                alias && alias !== "Self"
                  ? this.resolveImportedInstance(alias, n)
                  : this.resourceInstances.get(n)?.instance,
              (n) => this.hasManifest(n) && !this.resourceInstances.has(n),
            );
          }
          if (instance.init) await instance.init(ctx);
          if (instance.snapshot) {
            const snap = await Promise.resolve(instance.snapshot());
            this.onResourceSnapshotted(name, (snap as Record<string, unknown>) ?? {});
          }
          this.resourceInstances.set(name, { resource, instance });
          this.createdInstances.delete(name);
          errors.delete(name);
          progress = true;
          await this.emit(`${resource.kind}.${resource.metadata.name}.Initialized`, {
            resource: { kind: resource.kind, name: resource.metadata.name },
          });
        } catch (error) {
          if (error instanceof RuntimeError && (error.code === "ERR_VISIBILITY_DENIED" || error.code === "ERR_FATAL")) throw error;
          errors.set(name, formatErrorForDiagnostic(error));
        }
      }

      pass++;
      if (!progress) break;
    } while (pass <= MAX_PASSES);

    if (this.pendingResources.length > 0 || this.createdInstances.size > 0) {
      const diagnostics: RuntimeDiagnostic[] = [
        ...this.pendingResources.map((r) => {
          const info = errors.get(r.metadata.name) ?? { message: "Unknown error" };
          return {
            resource: r.metadata.name,
            kind: r.kind,
            message: info.message,
            details: info.details,
            code: info.code,
          };
        }),
        ...[...this.createdInstances].map(([name, { resource }]) => {
          const info = errors.get(name) ?? { message: "Unknown error" };
          return {
            resource: name,
            kind: resource.kind,
            message: info.message,
            details: info.details,
            code: info.code,
          };
        }),
      ];
      const textDetails = diagnostics
        .map((d) => {
          const head = `  ${d.kind ? `${d.kind} ` : ""}${d.resource}: ${d.message}${d.code ? ` [${d.code}]` : ""}`;
          const extra = d.details ? "\n" + d.details.split("\n").map((l) => `    ${l}`).join("\n") : "";
          return head + extra;
        })
        .join("\n");
      throw new RuntimeError(
        "ERR_RESOURCE_INITIALIZATION_FAILED",
        `Unable to process resources:\n${textDetails}`,
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
          child.preInitHook = (resource, childGetInstance, childIsPending) => {
            parentHook(
              resource,
              (name, alias) =>
                alias && alias !== "Self"
                  ? parent.resolveImportedInstance(alias, name)
                  : childGetInstance(name) ?? parent.resourceInstances.get(name)?.instance,
              // A scoped ref resolves against the scope's own resources or an already-inited
              // outer one; only a scope-local dependency can still be pending. The outer is
              // live by the time a scope opens, so the child's own predicate suffices.
              childIsPending,
            );
          };
        }

        try {
          for (const manifest of manifests) {
            child.registerManifest(manifest);
          }
          await child.initializeResources();
          const scope: ScopeContext = {
            getInstance(name: string, alias?: string): ResourceInstance {
              // Cross-module exported instance (`!ref Alias.name` inside the scope) —
              // route into the owning import's child context, not scope-local resources.
              if (alias && alias !== "Self") {
                const imported = parent.resolveImportedInstance(alias, name);
                if (imported) return imported;
                throw new RuntimeError(
                  "ERR_SCOPE_RESOURCE_NOT_FOUND",
                  `Cross-module reference '${alias}.${name}' did not resolve to an exported instance.`,
                );
              }
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
  async invoke<TInputs>(
    kind: string,
    name: string,
    inputs: TInputs,
    ctx?: InvokeContext,
  ): Promise<any> {
    const entry = this.resourceInstances.get(name);

    if (!entry) {
      throw new RuntimeError(
        "ERR_RESOURCE_NOT_FOUND",
        `Resource not found for invocation: ${kind}.${name}. Available resources: ${[...this.resourceInstances.keys()].join(", ")}`,
      );
    }

    // A `!ref` whose kind couldn't be determined at resolve time (e.g. a
    // scope-local target absent from the static manifest set) arrives with an
    // empty kind; dispatch is by name, so recover the authoritative kind from
    // the resolved entry for event topics and error messages.
    const effectiveKind = kind || (entry.resource.kind as string);

    if (
      typeof entry.instance.invoke !== "function" &&
      typeof entry.instance.run !== "function"
    ) {
      throw new RuntimeError(
        "ERR_RESOURCE_NOT_INVOKABLE",
        `Resource ${effectiveKind}.${name} does not have an invoke or run method`,
      );
    }

    return this.runInvoke(effectiveKind, name, entry.instance, inputs, ctx);
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
    ctx?: InvokeContext,
  ): Promise<any> {
    if (typeof instance.invoke !== "function" && typeof instance.run !== "function") {
      throw new RuntimeError(
        "ERR_RESOURCE_NOT_INVOKABLE",
        `Resource ${kind}.${name} does not have an invoke or run method`,
      );
    }
    return this.runInvoke(kind, name, instance, inputs, ctx);
  }

  /**
   * Build the structured trace payload every capability dispatch emits. The
   * event *name* stays human-meaningful (`<name>.Invoked`) for bus subscribers;
   * everything a debug consumer needs to rebuild the call tree rides here, so the
   * consumer never parses the dotted name. `spanId`/`parentSpanId` are the
   * tracer's `invocationId`/`parentInvocationId` (present only while tracing);
   * `ref` carries the kind+name the name no longer encodes; `detail` is the
   * per-capability data (inputs/outputs, error fields, cancellation reason).
   */
  /**
   * A redacted snapshot of the CEL root scope a debug consumer should see for a
   * trace — `variables`, masked `secrets`, resource `snapshots`, `ports`. Attached
   * to a trace's *root* span so the consumer can inspect what data the execution
   * could reference (beyond its own inputs/outputs). Only a `ModuleContext` owns a
   * root scope; child scopes return undefined. Host `env` is deliberately omitted
   * (it is the raw process environment — too broad/sensitive to dump).
   */
  protected traceRootScope(): Record<string, unknown> | undefined {
    return undefined;
  }

  protected tracePayload(
    kind: string,
    name: string,
    spanId: number | undefined,
    parentSpanId: number | undefined,
    traceId: string | undefined,
    capability: "invoke" | "run" | "provide" | "request",
    phase: "start" | "end",
    outcome: "ok" | "failed" | "rejected" | "cancelled" | undefined,
    detail: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      traceId,
      spanId,
      parentSpanId,
      capability,
      phase,
      ...(outcome !== undefined ? { outcome } : {}),
      ref: { kind, name },
      ...detail,
    };
  }

  private async runInvoke<TInputs>(
    kind: string,
    name: string,
    instance: ResourceInstance,
    inputs: TInputs,
    ctx?: InvokeContext,
  ): Promise<any> {
    // Explicit seed (trigger / embedder) wins; otherwise inherit the ambient
    // tree token; otherwise open a fresh, never-cancellable scope. The token
    // reaches the controller only as the explicit argument below.
    const ambient = cancellationStore.getStore();
    const baseCtx = ctx ?? ambient ?? UNCANCELLABLE_CONTEXT;
    const token = baseCtx.cancellation;

    // Tracing gate (a debug consumer is attached): mint a monotonic id for this
    // invocation, parent it to the ambient one, and ride both in every event's
    // payload so the consumer can rebuild the call tree. Off by default —
    // `invokeCtx` stays `baseCtx` and the fast `=== ambient` skip is preserved.
    const tracing = this.tracer?.enabled === true;
    const invocationId = tracing ? this.tracer!.next() : undefined;
    // Parent precedence mirrors the token: an explicit seed `ctx` wins, then the
    // ambient (ALS) invocation. A caller threading its own `ctx.invocationId` thus
    // has it honored as the parent, not silently dropped for the ALS value.
    const parentInvocationId = ctx?.invocationId ?? ambient?.invocationId;
    // Inherit the trace from the parent (explicit ctx wins, then ambient); mint a
    // fresh one only at a root. Carried on every span so an OTel exporter groups
    // the trace without walking the parent chain.
    const traceId = tracing
      ? (ctx?.traceId ?? ambient?.traceId ?? this.tracer!.newTraceId())
      : undefined;
    // Capture the root CEL scope once, on the trace's root span's terminal event.
    const rootScope = tracing && parentInvocationId === undefined ? this.traceRootScope() : undefined;
    const span = (
      phase: "start" | "end",
      outcome: "ok" | "failed" | "rejected" | "cancelled" | undefined,
      detail: Record<string, unknown>,
    ) =>
      this.tracePayload(
        kind,
        name,
        invocationId,
        parentInvocationId,
        traceId,
        "invoke",
        phase,
        outcome,
        phase === "end" && rootScope ? { ...detail, context: rootScope } : detail,
      );
    // When tracing, a fresh context carries the new id down the tree so nested
    // invokes read it as their parent; it is never `=== ambient`, so the call
    // always (re)establishes the ALS scope.
    const invokeCtx: InvokeContext = tracing
      ? { cancellation: token, invocationId, parentInvocationId, traceId }
      : baseCtx;

    // Pre-dispatch gate: a sub-invoke reached after the tree was cancelled is
    // refused without ever touching the controller.
    if (token.isCancelled) {
      await this.emit(`${name}.InvokeCancelled`, span("end", "cancelled", { inputs, reason: token.reason }));
      throw new RuntimeError(
        "ERR_INVOKE_CANCELLED",
        `Invoke ${kind}.${name} was cancelled${token.reason ? `: ${token.reason}` : ""}`,
      );
    }

    // Start span — only under tracing, so non-traced behaviour stays exactly
    // one terminal event per call (subscribers to `<name>.Invoked` are unaffected).
    if (tracing) await this.emit(`${name}.Invoking`, span("start", undefined, { inputs }));

    try {
      // Only (re)establish the ALS scope when the token differs from the ambient
      // one — nested invokes that inherited it skip the redundant `run`.
      // A step / boot-target slot may reference a pure Runnable (the schema
      // allows `telo#Runnable` alongside `telo#Invocable`); dispatch it via
      // `run()` — side effects only, no outputs. Prefer `invoke()` when both
      // exist so a dual-capability instance (e.g. Run.Sequence) keeps invoke
      // semantics and returns its `steps`/`outputs`.
      const call = () =>
        typeof instance.invoke === "function"
          ? (instance.invoke as (i: any, c?: InvokeContext) => any)(inputs as any, invokeCtx)
          : (instance.run as (c?: InvokeContext) => any)(invokeCtx);
      const outputs = await (invokeCtx === ambient
        ? call()
        : cancellationStore.run(invokeCtx, call));
      await this.emit(`${name}.Invoked`, span("end", "ok", { inputs, outputs }));
      return outputs;
    } catch (err) {
      // Cooperative mid-flight cancellation (`throwIfCancelled`) joins the same
      // observable event family rather than masquerading as a rejection/failure.
      if (isCancellationError(err)) {
        const reason = err instanceof Error ? err.message : String(err);
        await this.emit(`${name}.InvokeCancelled`, span("end", "cancelled", { inputs, reason }));
        throw err;
      }
      if (isInvokeError(err)) {
        const detail = { inputs, code: err.code, message: err.message, data: err.data };
        await this.emit(`${name}.InvokeRejected`, span("end", "rejected", detail));
        const declaredCodes = this.getDeclaredThrowCodes(kind);
        if (declaredCodes && !declaredCodes.has(err.code)) {
          await this.emit(`${name}.InvokeRejected.Undeclared`, span("end", "rejected", detail));
        }
        throw err;
      }
      if (err instanceof Error) {
        await this.emit(
          `${name}.InvokeFailed`,
          span("end", "failed", { inputs, name: err.name, message: err.message }),
        );
      } else {
        await this.emit(
          `${name}.InvokeFailed`,
          span("end", "failed", { inputs, name: "UnknownError", message: String(err) }),
        );
      }
      // Already enriched at an inner invoke: keep the innermost (most
      // specific) resource as the failure location.
      if (err instanceof RuntimeError && err.diagnostics?.length) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof Error ? err.name : undefined;
      // Keep `message` raw so callers (Run.Sequence catch blocks, assertions)
      // see the original error text unchanged. Resource context lives only on
      // the attached diagnostic, which the CLI's formatter renders as the
      // location prefix. Attach the original error as `cause` so
      // formatErrorForDiagnostic walks the chain and surfaces the underlying
      // stack and well-known error fields (AWS, pg, Node system errors).
      const wrapped = new RuntimeError("ERR_EXECUTION_FAILED", message, [
        { kind, resource: name, message, code },
      ]);
      (wrapped as { cause?: unknown }).cause = err;
      throw wrapped;
    }
  }

  /**
   * The declared capability of a kind, or undefined if unknown. Definitions are
   * keyed by their canonical `<module>.<Kind>`, but a resource carries the alias
   * kind it was written with (`Http.Server`), so resolve the alias first.
   * Best-effort: `resolveKind` exists only on a `ModuleContext` and throws for
   * unqualified / ungated kinds, so guard and fall back to the raw kind.
   */
  /** Resolve an alias kind (`Http.Server`) to its canonical `<module>.<Kind>`.
   *  Only a `ModuleContext` carries the import-alias table; the base returns the
   *  kind unchanged. A typed seam (overridden in `ModuleContext`), matching the
   *  `traceRootScope()` pattern, rather than reaching across the boundary. */
  protected resolveKindSafe(kind: string): string {
    return kind;
  }

  private capabilityOf(kind: string): string | undefined {
    const resolved = this.resolveKindSafe(kind);
    return this.getDefinition?.(resolved)?.capability ?? this.getDefinition?.(kind)?.capability;
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

  async run(name: string, ctx?: InvokeContext): Promise<void> {
    const entry = this.resourceInstances.get(name);
    if (!(entry && typeof entry.instance.run === "function")) {
      throw new RuntimeError(
        "ERR_RESOURCE_NOT_RUNNABLE",
        `Resource ${name} is not runnable or not found. Available resources: ${[...this.resourceInstances.keys()].join(", ")}`,
      );
    }
    return this.runInstance(entry.resource.kind as string, name, entry.instance, ctx);
  }

  /**
   * Like run(), but the caller has already resolved the instance (e.g. a
   * Phase-5-injected `!ref` boot target). Shares the single span-emitting path so
   * a pre-resolved runnable is instrumented exactly like a by-name dispatch
   * instead of escaping the chokepoint with a direct `instance.run()` call.
   */
  async runResolved(
    kind: string,
    name: string,
    instance: ResourceInstance,
    ctx?: InvokeContext,
  ): Promise<void> {
    if (typeof instance.run !== "function") {
      throw new RuntimeError(
        "ERR_RESOURCE_NOT_RUNNABLE",
        `Resource ${kind}.${name} does not have a run method`,
      );
    }
    return this.runInstance(kind, name, instance, ctx);
  }

  /**
   * Open a trace span for an inbound boundary (an HTTP request). Mints a span
   * that roots a fresh trace (or continues `opts.inbound`), emits its `start`,
   * and returns a child context to thread into `invokeResolved` so the handler
   * nests under it. A no-op pass-through when tracing is off.
   */
  async openSpan(base: InvokeContext | undefined, opts: OpenSpanOptions): Promise<OpenSpan> {
    const ctx = base ?? UNCANCELLABLE_CONTEXT;
    if (this.tracer?.enabled !== true) {
      return { context: ctx, settle: async () => {} };
    }
    const spanId = this.tracer.next();
    const traceId = opts.inbound?.traceId ?? this.tracer.newTraceId();
    const parentSpanId = opts.inbound?.parentSpanId;
    // A root request span (not continuing an upstream trace) carries the root scope.
    const rootScope = parentSpanId === undefined ? this.traceRootScope() : undefined;
    const detail = {
      ...(opts.label !== undefined ? { label: opts.label } : {}),
      ...(opts.attributes !== undefined ? { attributes: opts.attributes } : {}),
    };
    const payload = (
      phase: "start" | "end",
      outcome: "ok" | "failed" | "rejected" | "cancelled" | undefined,
      extra: Record<string, unknown> = {},
    ) =>
      this.tracePayload(
        opts.ref.kind,
        opts.ref.name,
        spanId,
        parentSpanId,
        traceId,
        "request",
        phase,
        outcome,
        { ...detail, ...extra },
      );

    await this.emit(`${opts.ref.name}.Requesting`, payload("start", undefined));
    const context: InvokeContext = {
      cancellation: ctx.cancellation,
      invocationId: spanId,
      parentInvocationId: parentSpanId,
      traceId,
    };
    let settled = false;
    return {
      context,
      settle: async (outcome, extra) => {
        if (settled) return;
        settled = true;
        await this.emit(
          `${opts.ref.name}.Request`,
          payload("end", outcome, rootScope ? { ...extra, context: rootScope } : extra),
        );
      },
    };
  }

  private async runInstance(
    kind: string,
    name: string,
    instance: ResourceInstance,
    ctx?: InvokeContext,
  ): Promise<void> {
    const ambient = cancellationStore.getStore();
    const baseCtx = ctx ?? ambient ?? UNCANCELLABLE_CONTEXT;
    const token = baseCtx.cancellation;

    // A long-lived Service's `run()` is not a one-shot dispatch: it stays pending
    // for the process lifetime, so wrapping it in the cancellation/trace ALS scope
    // would leak that scope onto every async resource the service creates (e.g. an
    // HTTP server's listening socket → every inbound request callback). Such a
    // service must NOT establish an ambient: its token reaches it via the explicit
    // `run(invokeCtx)` argument (how it observes shutdown), and its externally
    // triggered work then starts with a clean ambient — separate traces, no
    // inherited cancellation. Runnables (one-shot, e.g. `Run.Sequence`) keep the
    // ALS scope so their steps nest and inherit cancellation.
    const isService = this.capabilityOf(kind) === "Telo.Service";

    // Span instrumentation mirrors `runInvoke` — minting an id here makes
    // Runnables (a `Run.Sequence` boot target) appear in the trace and re-parents
    // their nested invokes. A long-lived Service emits only the `start` span (its
    // `run()` resolves at teardown), the "running" signal a debug consumer wants.
    const tracing = this.tracer?.enabled === true;
    const invocationId = tracing ? this.tracer!.next() : undefined;
    const parentInvocationId = ctx?.invocationId ?? ambient?.invocationId;
    const traceId = tracing
      ? (ctx?.traceId ?? ambient?.traceId ?? this.tracer!.newTraceId())
      : undefined;
    const rootScope = tracing && parentInvocationId === undefined ? this.traceRootScope() : undefined;
    const span = (
      phase: "start" | "end",
      outcome: "ok" | "failed" | "cancelled" | undefined,
      detail: Record<string, unknown>,
    ) =>
      this.tracePayload(
        kind,
        name,
        invocationId,
        parentInvocationId,
        traceId,
        "run",
        phase,
        outcome,
        phase === "end" && rootScope ? { ...detail, context: rootScope } : detail,
      );
    const invokeCtx: InvokeContext = tracing
      ? { cancellation: token, invocationId, parentInvocationId, traceId }
      : baseCtx;

    // Refuse a target reached after the boot run was cancelled.
    if (token.isCancelled) {
      await this.emit(`${name}.RunCancelled`, span("end", "cancelled", { reason: token.reason }));
      throw new RuntimeError(
        "ERR_INVOKE_CANCELLED",
        `Run ${kind}.${name} was cancelled${token.reason ? `: ${token.reason}` : ""}`,
      );
    }

    if (tracing) await this.emit(`${name}.Running`, span("start", undefined, {}));

    try {
      // Runnable: run inside the ALS scope so nested invokes inherit the token and
      // trace id (skip the redundant `run` when the token is already ambient).
      // Service: call directly with the explicit context and NO ambient scope, so
      // its long-lived async work does not capture this scope.
      const call = () => (instance.run as (c?: InvokeContext) => Promise<void>)(invokeCtx);
      await (isService || invokeCtx === ambient ? call() : cancellationStore.run(invokeCtx, call));
      await this.emit(`${name}.Run`, span("end", "ok", {}));
    } catch (err) {
      if (isCancellationError(err)) {
        const reason = err instanceof Error ? err.message : String(err);
        await this.emit(`${name}.RunCancelled`, span("end", "cancelled", { reason }));
        throw err;
      }
      const detail =
        err instanceof Error
          ? { name: err.name, message: err.message }
          : { name: "UnknownError", message: String(err) };
      await this.emit(`${name}.RunFailed`, span("end", "failed", detail));
      throw err;
    }
  }

  /**
   * Run `fn` detached from the caller's cancellation/trace scope. The current
   * ambient `InvokeContext` (a request's token + span) is replaced with the
   * uncancellable root, so request-scope teardown cannot abort the work and it
   * does not nest under the request's trace. This is the bare scope primitive —
   * tracking/draining a detached task is the owning resource's concern (the
   * per-resource `ResourceContext` records the task and drains it in the
   * resource's teardown).
   */
  runDetached<T>(fn: () => Promise<T>): Promise<T> {
    return cancellationStore.run(UNCANCELLABLE_CONTEXT, fn);
  }

  /**
   * Expand a value that may contain precompiled ${{ }} templates.
   *
   * Hot path: each unique manifest subtree is compiled once into a tightly-bound
   * walker closure (no per-call `isCompiledValue` / `Array.isArray` / `typeof` /
   * `Object.entries` overhead, no recursive method dispatch). The walker tree is
   * cached by the input value's identity in `walkerCache`, so subsequent calls
   * with the same manifest data reuse it. The walker reads from `this._context`
   * — which `expandWith` mutates in place — and emits a fresh container per call
   * to preserve the original recursive `expand`'s semantics.
   */
  expand(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    const cached = this.walkerCache.get(value as object);
    if (cached) return cached(this._context);
    const walker = compileWalker(value);
    this.walkerCache.set(value as object, walker);
    return walker(this._context);
  }

  /**
   * Expand a value using this context merged with additional properties.
   *
   * Hot path optimisation: rather than allocate a fresh prototype-less object
   * per call (one allocation + N property copies for N keys in the saved
   * context), we mutate `_context` in place — adding or overwriting only the
   * `extraContext` keys — and restore the previous values on exit. Safe because
   * `expand` is synchronous; cel-vm closures only read from the activation.
   */
  expandWith(value: unknown, extraContext: Record<string, unknown>): unknown {
    const ctx = this._context as Record<string, unknown>;
    const keys = Object.keys(extraContext);
    const savedValues: unknown[] = new Array(keys.length);
    const hadKey: boolean[] = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      hadKey[i] = k in ctx;
      if (hadKey[i]) savedValues[i] = ctx[k];
      ctx[k] = extraContext[k];
    }
    try {
      return this.expand(value);
    } finally {
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        if (hadKey[i]) ctx[k] = savedValues[i];
        else delete ctx[k];
      }
    }
  }

  /** Cache of compiled walker closures keyed on the manifest subtree they walk.
   *  WeakMap so entries are GC'd if the manifest is reloaded. */
  private readonly walkerCache = new WeakMap<
    object,
    (ctx: Record<string, unknown>) => unknown
  >();

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

type AccessToken = { kind: "id"; name: string } | { kind: "index"; index: number };

/**
 * Tokenize a CEL source string as a simple member-access path
 * (e.g. `steps.call.result.content[0].type`). Returns null when the source
 * contains anything beyond bare identifiers, dot access, and numeric/string
 * bracket access (function calls, operators, optionals, comprehensions, etc.)
 * — the enrichment is best-effort for the common dotted-path case.
 */
function tokenizeAccessPath(source: string): AccessToken[] | null {
  const s = source.trim();
  const idRe = /^[A-Za-z_][A-Za-z0-9_]*/;
  const root = idRe.exec(s);
  if (!root) return null;
  const tokens: AccessToken[] = [{ kind: "id", name: root[0] }];
  let i = root[0].length;
  while (i < s.length) {
    const c = s[i];
    if (c === ".") {
      i++;
      if (s[i] === "?") return null;
      const m = idRe.exec(s.slice(i));
      if (!m) return null;
      const afterId = i + m[0].length;
      if (s[afterId] === "(") return null;
      tokens.push({ kind: "id", name: m[0] });
      i = afterId;
    } else if (c === "[") {
      if (s[i + 1] === "?") return null;
      const close = s.indexOf("]", i);
      if (close === -1) return null;
      const inner = s.slice(i + 1, close).trim();
      if (/^\d+$/.test(inner)) {
        tokens.push({ kind: "index", index: parseInt(inner, 10) });
      } else if (/^"[^"\\]*"$/.test(inner) || /^'[^'\\]*'$/.test(inner)) {
        tokens.push({ kind: "id", name: inner.slice(1, -1) });
      } else {
        return null;
      }
      i = close + 1;
    } else {
      return null;
    }
  }
  return tokens;
}

/**
 * Best-effort enrichment for CEL "No such key" failures. Walks the source
 * access path against the activation, finds the deepest reachable value, and
 * returns a single-line hint describing what was actually at that point
 * (object keys, array length, scalar type) so developers can immediately see
 * which segment of the chain produced an unexpected shape.
 *
 * Returns null when the error isn't a key-access failure, when the source
 * can't be parsed as a plain access path, or when the path can't be matched
 * against the activation — callers fall back to the original error text.
 */
export function describeFailedAccess(
  source: string,
  ctx: unknown,
  msg: string,
): string | null {
  const m = /^No such key:\s*(\S+)/.exec(msg);
  if (!m) return null;
  const missingKey = m[1];

  const tokens = tokenizeAccessPath(source);
  if (!tokens || tokens.length < 2) return null;
  if (tokens[0].kind !== "id") return null;
  if (typeof ctx !== "object" || ctx === null) return null;

  const rootName = tokens[0].name;
  if (!(rootName in (ctx as Record<string, unknown>))) return null;
  let current: unknown = (ctx as Record<string, unknown>)[rootName];
  const walked: string[] = [rootName];

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind === "id") {
      if (
        current === null ||
        current === undefined ||
        typeof current !== "object" ||
        Array.isArray(current) ||
        !(tok.name in (current as Record<string, unknown>))
      ) {
        if (tok.name !== missingKey) return null;
        return `at ${walked.join("")}: ${describeMissingAccess(current, missingKey)}`;
      }
      current = (current as Record<string, unknown>)[tok.name];
      walked.push("." + tok.name);
    } else {
      if (current === null || current === undefined || typeof current !== "object") {
        return null;
      }
      current = (current as Record<number, unknown>)[tok.index];
      walked.push(`[${tok.index}]`);
    }
  }
  return null;
}

function describeMissingAccess(value: unknown, key: string): string {
  if (value === null) return `cannot read '${key}' — value is null`;
  if (value === undefined) return `cannot read '${key}' — value is undefined`;
  if (Array.isArray(value)) {
    return `cannot read '${key}' — value is an array of length ${value.length}`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return `cannot read '${key}' — value is an empty object {}`;
    return `cannot read '${key}' — available keys: ${keys.join(", ")}`;
  }
  if (typeof value === "string") {
    const preview = value.length > 40 ? value.slice(0, 40) + "…" : value;
    return `cannot read '${key}' — value is a string (${JSON.stringify(preview)})`;
  }
  return `cannot read '${key}' — value is ${typeof value} (${String(value)})`;
}

/**
 * Build a detailed diagnostic from an arbitrary error. Walks the `cause` chain
 * and surfaces structured fields from well-known error shapes (AWS SDK
 * ServiceException, pg DatabaseError, Node system errors) so the user sees the
 * actual failure instead of just an opaque summary string.
 */
function formatErrorForDiagnostic(err: unknown): {
  message: string;
  code?: string;
  details?: string;
} {
  if (!(err instanceof Error)) {
    return { message: String(err) };
  }

  const detailLines: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  let depth = 0;
  let topCode: string | undefined;
  let topMessage = "";

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const info = extractErrorInfo(current);
    if (depth === 0) {
      topMessage = info.summary;
      topCode = info.code;
    } else {
      detailLines.push(`Caused by: ${info.summary}`);
    }
    for (const field of info.fields) {
      detailLines.push(field);
    }
    current = (current as { cause?: unknown }).cause;
    depth++;
  }

  return {
    message: topMessage || err.message || err.name || String(err),
    code: topCode,
    details: detailLines.length ? detailLines.join("\n") : undefined,
  };
}

function extractErrorInfo(e: Error): { summary: string; code?: string; fields: string[] } {
  const fields: string[] = [];
  const anyE = e as unknown as Record<string, unknown>;

  const name = e.name && e.name.toLowerCase() !== "error" ? e.name : undefined;
  const code = anyE.code !== undefined && anyE.code !== null ? String(anyE.code) : undefined;
  const message = e.message && e.message.trim() ? e.message : "(no message)";

  const summary = name ? `${name}: ${message}` : message;

  const metadata = anyE.$metadata as Record<string, unknown> | undefined;
  if (metadata && typeof metadata === "object") {
    if (metadata.httpStatusCode != null) fields.push(`HTTP status: ${metadata.httpStatusCode}`);
    if (metadata.requestId) fields.push(`Request ID: ${metadata.requestId}`);
    if (metadata.extendedRequestId) fields.push(`Extended request ID: ${metadata.extendedRequestId}`);
    if (metadata.cfId) fields.push(`CF ID: ${metadata.cfId}`);
    if (metadata.attempts != null) fields.push(`Attempts: ${metadata.attempts}`);
    if (metadata.totalRetryDelay != null) fields.push(`Total retry delay: ${metadata.totalRetryDelay}ms`);
  }
  if (anyE.$fault) fields.push(`Fault: ${String(anyE.$fault)}`);

  if (anyE.severity) fields.push(`Severity: ${String(anyE.severity)}`);
  if (anyE.detail) fields.push(`Detail: ${String(anyE.detail)}`);
  if (anyE.hint) fields.push(`Hint: ${String(anyE.hint)}`);
  if (anyE.schema) fields.push(`Schema: ${String(anyE.schema)}`);
  if (anyE.table) fields.push(`Table: ${String(anyE.table)}`);
  if (anyE.column) fields.push(`Column: ${String(anyE.column)}`);
  if (anyE.dataType) fields.push(`Data type: ${String(anyE.dataType)}`);
  if (anyE.constraint) fields.push(`Constraint: ${String(anyE.constraint)}`);
  if (anyE.routine) fields.push(`Routine: ${String(anyE.routine)}`);
  if (anyE.where) fields.push(`Where: ${String(anyE.where)}`);
  if (anyE.position) fields.push(`Position: ${String(anyE.position)}`);
  if (anyE.internalPosition) fields.push(`Internal position: ${String(anyE.internalPosition)}`);
  if (anyE.internalQuery) fields.push(`Internal query: ${String(anyE.internalQuery)}`);

  if (anyE.syscall) fields.push(`Syscall: ${String(anyE.syscall)}`);
  if (anyE.errno != null) fields.push(`Errno: ${String(anyE.errno)}`);
  if (anyE.address) fields.push(`Address: ${String(anyE.address)}`);
  if (anyE.port != null) fields.push(`Port: ${String(anyE.port)}`);
  if (anyE.hostname) fields.push(`Hostname: ${String(anyE.hostname)}`);
  if (anyE.path && !anyE.routine) fields.push(`Path: ${String(anyE.path)}`);

  return { summary, code, fields };
}
