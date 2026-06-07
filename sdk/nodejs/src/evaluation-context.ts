import type { InvokeContext } from "./cancellation.js";
import type { ScopeHandle } from "./ref.js";
import type { ResourceInstance } from "./resource-instance.js";
import type { ResourceManifest } from "./resource-manifest.js";
import type { ResourceDefinition } from "./types.js";

export type EmitEvent = (event: string, payload?: any) => void | Promise<void>;

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
 */
export type PreInitHook = (
  resource: ResourceManifest,
  getInstance: (name: string, alias?: string) => ResourceInstance | undefined,
) => void;

/** Canonical key for a resource instance: "<module>.<kind>.<name>" */
export function resourceKey(r: ResourceManifest): string {
  return `${r.kind}.${r.metadata.name}`;
}

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

  readonly createInstance: InstanceFactory;
  readonly context: Record<string, unknown>;
  readonly secretValues: Set<string>;

  setInitOrder(names: string[]): void;
  hasManifest(name: string): boolean;
  registerManifest(resource: ResourceManifest): void;
  spawnChild<T extends EvaluationContext>(child: T): T;
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
  expand(value: unknown): unknown;
  expandWith(value: unknown, extraContext: Record<string, unknown>): unknown;
  expandPaths(
    value: Record<string, unknown>,
    paths: string[],
    excludePaths?: string[],
  ): Record<string, unknown>;
}
