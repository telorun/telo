import type { Invocable } from "./capabilities/invokable.js";
import type { Provider } from "./capabilities/provider.js";
import type { Runnable } from "./capabilities/runnable.js";
import type { ResourceContext } from "./resource-context.js";

export type ResourceInstance<TInput = Record<string, any>, TOutput = any> = Partial<
  Invocable<TInput, TOutput>
> &
  Partial<Runnable> &
  Partial<Provider<TOutput>> & {
    init?(ctx?: ResourceContext): Promise<void>;
    teardown?(): void | Promise<void>;
    snapshot?(): Record<string, any> | Promise<Record<string, any>>;
    /**
     * Teardown ordering hint. Instances tear down in ascending priority — a
     * higher number means *later*. Default `0`; within one priority the base
     * order (reverse init) is preserved.
     *
     * This exists because the base order is reverse *insertion* order, which the
     * multi-pass init retry can perturb, so a resource that must reliably outlive
     * the rest at shutdown cannot express that through the dependency graph. Log
     * sinks set {@link TEARDOWN_LAST} so they flush after every resource that
     * might log while shutting down — a generic mechanism, not a logging-specific
     * carve-out in the teardown path.
     */
    teardownPriority?: number;
  };

/** Teardown-last priority (see {@link ResourceInstance.teardownPriority}). Log
 *  sinks use it so anything logging during its own teardown still reaches a live
 *  destination. */
export const TEARDOWN_LAST = 1000;

/** The kind+name an instance was resolved from. */
export interface RefIdentity {
  kind: string;
  name: string;
}

/**
 * Kernel-minted, unique per LIVE instance, stable for its lifetime. Distinct
 * from {@link RefIdentity}: a `with:`-scoped resource has one declaration and
 * one instance per scope run, and correlation must see those as different.
 * A string rather than an object reference so it serializes across the ABI —
 * a second-language kernel compares the same value.
 */
export type ResourceInstanceId = string & { readonly __brand: "ResourceInstanceId" };

/**
 * Typed identity of a live resource instance. `id` is the only thing compared;
 * `ref` is where the instance was declared — diagnostics only, so an error can
 * say *no transaction open on connection `appDb`* instead of printing an id.
 */
export interface ResourceHandle {
  readonly id: ResourceInstanceId;
  readonly ref: RefIdentity;
}

export const sameResource = (a: ResourceHandle, b: ResourceHandle): boolean => a.id === b.id;

/**
 * Non-enumerable identity tag the kernel stamps on a live instance when it
 * injects a resolved `!ref` into a slot. A consumer that holds only the bare
 * instance (an `executeInvokeStep` target whose `!ref` was pre-injected) can
 * then recover the kind+name and dispatch through the traced chokepoint
 * (`invokeResolved`) instead of calling `.invoke()` directly and escaping it.
 */
export const REF_IDENTITY: unique symbol = Symbol.for("telo.refIdentity");

/** Stamp the resolved kind+name onto an injected instance. Idempotent — an
 *  instance has exactly one identity, so re-injection into other slots is a no-op. */
export function stampRefIdentity(instance: object, kind: string, name: string): void {
  if (!(REF_IDENTITY in instance)) {
    Object.defineProperty(instance, REF_IDENTITY, {
      value: { kind, name } satisfies RefIdentity,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }
}

/** Read the identity stamped by {@link stampRefIdentity}, if any. */
export function getRefIdentity(instance: object): RefIdentity | undefined {
  return (instance as Record<symbol, RefIdentity | undefined>)[REF_IDENTITY];
}
