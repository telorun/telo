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
  };

/** The kind+name an instance was resolved from. */
export interface RefIdentity {
  kind: string;
  name: string;
}

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
