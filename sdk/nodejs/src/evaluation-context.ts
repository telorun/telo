import type { InvokeContext, OpenSpan, OpenSpanOptions } from "./cancellation.js";
import type { ScopeHandle } from "./ref.js";
import type { ResourceInstance } from "./resource-instance.js";
import type { ResourceManifest } from "./resource-manifest.js";
import type { ResourceDefinition } from "./types.js";

export type EmitEvent = (
  event: string,
  payload?: any,
  metadata?: Record<string, any>,
) => void | Promise<void>;

/**
 * Per-kernel invocation tracer. Mints monotonic invocation ids and carries the
 * gate that turns tracing on (a debug consumer is attached). Owned by the kernel,
 * injected into the context tree; `enabled === false` is the zero-overhead default.
 */
export interface Tracer {
  readonly enabled: boolean;
  /** Mint the next monotonic invocation id (unique within the kernel run). */
  next(): number;
  /** Mint a fresh trace id (OTel-compatible 16-byte hex) for a new root trace.
   *  Children inherit it via {@link InvokeContext.traceId}. */
  newTraceId(): string;
}

/** Four-stage resource lifecycle defined in resource-lifecycle.md */
export type LifecycleState = "Pending" | "Validated" | "Initialized" | "Draining" | "Teardown";

/**
 * Result of the create phase: the instance and its bound ResourceContext.
 * The ctx is typed as any to avoid a circular import with resource-context.ts.
 */
export type CreatedResource = {
  instance: ResourceInstance;
  ctx: any;
  // The resource manifest the controller was actually created with. When the factory
  // expands compile-time CEL fields it hands the controller an expanded clone; returning
  // it here lets initializeResources inject live instances (preInitHook) into THAT object
  // — the one the controller reads — instead of the pre-expansion original.
  resource: ResourceManifest;
};

/**
 * Creates a ResourceInstance for the given manifest, or returns null if not yet
 * ready (e.g. a dependency is still initializing). Injected at construction so
 * every EvaluationContext node owns its full resource lifecycle.
 * Returns a CreatedResource (instance + ctx) so initializeResources can run
 * init() separately in a second phase.
 */
export type InstanceFactory = (
  context: EvaluationContext,
  resource: ResourceManifest,
) => Promise<CreatedResource | null>;

/**
 * Hook called after controller.create() and before controller.init() for each resource.
 * Implementations (e.g. the kernel) use this to inject live instances into reference
 * fields of the resource config before the controller sees them in init().
 *
 * @param resource  The resource manifest whose config fields may be mutated in-place.
 * @param getInstance  Looks up an already-initialized instance by resource name. With a
 *                     non-`Self` `alias`, resolves a cross-module reference into that
 *                     import's published exported instances instead of the local context.
 *                     Returns undefined when the named resource is not yet initialized.
 * @param isPending  Reports whether a local (no-alias) reference names a resource that is
 *                   registered in this context but not yet initialized. Injection uses it
 *                   to defer a resource whose dependency exists but hasn't inited yet —
 *                   rather than leaving the slot unresolved — so the init loop retries it.
 */
export type PreInitHook = (
  resource: ResourceManifest,
  getInstance: (name: string, alias?: string) => ResourceInstance | undefined,
  isPending?: (name: string) => boolean,
) => void;

/** Canonical key for a resource instance: "<module>.<kind>.<name>" */
export function resourceKey(r: ResourceManifest): string {
  return `${r.kind}.${r.metadata.name}`;
}

/** The resource that owns a spawned child context — the parent in the resource
 *  topology. `id` is the owner's full hierarchical id (`<owner.id>/<kind>.<name>`,
 *  or just `<kind>.<name>` at the top level), so a child's own id qualifies under
 *  it and stays unique across instances of the same templated kind. */
export type ResourceOwner = { kind: string; name: string; id: string };

/**
 * Public contract for the base evaluation context.
 *
 * Owns template expansion, secrets redaction, and the generic resource lifecycle tree.
 * The class implementation lives in `@telorun/kernel`.
 */
export interface EvaluationContext {
  readonly id: string;
  readonly source: string;
  readonly emit: EmitEvent;

  parent: EvaluationContext | undefined;
  readonly children: EvaluationContext[];

  state: LifecycleState;

  readonly resourceInstances: Map<
    string,
    { resource: ResourceManifest; instance: ResourceInstance }
  >;

  preInitHook?: PreInitHook;

  /** Looks up a registered resource definition by fully-qualified kind.
   *  Set by the kernel; used for declared-throw-union checks. */
  getDefinition?: (kind: string) => ResourceDefinition | undefined;

  /** Per-kernel invocation tracer. Set by the kernel on the root context and
   *  propagated through `spawnChild`; drives invocation-id minting in `invoke`. */
  tracer?: Tracer;

  /** The resource that spawned this context's resources, if any. A template
   *  controller stamps it on the child context it registers its `resources:`
   *  into, so the lifecycle/dispatch events those children emit carry the owning
   *  resource — letting a debug consumer nest them under their parent and keep
   *  two instances of the same templated kind from colliding by name. `id` is the
   *  owner's full hierarchical id (`<owner.id>/<kind>.<name>`); undefined on a
   *  context whose resources are top-level. */
  owner?: ResourceOwner;

  /** The id prefix to prepend to a resource created in this context:
   *  `owner ? owner.id + "/" : ""`. A controller that spawns sub-resources reads
   *  it (via {@link ResourceContext.ownerPrefix}) to compose their hierarchical ids. */
  readonly ownerPrefix: string;

  readonly createInstance: InstanceFactory;
  readonly context: Record<string, unknown>;
  readonly secretValues: Set<string>;

  setInitOrder(names: string[]): void;
  hasManifest(name: string): boolean;
  registerManifest(resource: ResourceManifest): void;
  spawnChild<T extends EvaluationContext>(child: T): T;
  /** Spawn a fresh child context attached to this one — the isolated scope a
   *  templated definition registers its `resources:` into. Rooted here so child
   *  kinds/refs resolve against THIS context's imports (the defining library),
   *  not the consumer's. */
  spawnChildContext(): EvaluationContext;
  initializeResources(): Promise<void>;
  withManifests<T>(manifests: any[], fn: () => T): T;
  createScopeHandle(manifests: ResourceManifest[]): ScopeHandle;
  teardownResources(): Promise<void>;
  transientChild(context: Record<string, any>): EvaluationContext;
  invoke<TInputs>(kind: string, name: string, inputs: TInputs, ctx?: InvokeContext): Promise<any>;
  invokeResolved<TInputs>(
    kind: string,
    name: string,
    instance: ResourceInstance,
    inputs: TInputs,
    ctx?: InvokeContext,
  ): Promise<any>;
  run(name: string, ctx?: InvokeContext): Promise<void>;
  openSpan(base: InvokeContext | undefined, opts: OpenSpanOptions): Promise<OpenSpan>;
  /** Bare scope-detach primitive: run `fn` outside the caller's cancellation/
   *  trace scope. Tracking/draining the task is the owning `ResourceContext`'s
   *  concern (see {@link ResourceContext.runDetached}). */
  runDetached<T>(fn: () => Promise<T>): Promise<T>;
  expand(value: unknown): unknown;
  expandWith(value: unknown, extraContext: Record<string, unknown>): unknown;
  expandPaths(
    value: Record<string, unknown>,
    paths: string[],
    excludePaths?: string[],
  ): Record<string, unknown>;
}
