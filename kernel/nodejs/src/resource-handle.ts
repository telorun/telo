import type { ResourceHandle, ResourceInstanceId } from "@telorun/sdk";

/**
 * Instance → handle, minted at `create()` — the kernel's single
 * instance-production site, where the invocation contract already binds — so an
 * instance is never observable without one. The reverse direction deliberately
 * does not exist: nothing turns a handle back into someone else's live
 * instance, which is what keeps the ambient zone stack from leaking instances
 * across module boundaries.
 */
const handles = new WeakMap<object, ResourceHandle>();

let counter = 0;

/**
 * Mint (or return) the handle for a live instance. Idempotent, first mint wins
 * — a `base:` child IS its parent's instance returned verbatim, so the nested
 * parent create stamps first and the child create must not re-identify it; one
 * live instance, one id, exactly like `stampRefIdentity`.
 */
export function mintResourceHandle(instance: object, kind: string, name: string): ResourceHandle {
  const existing = handles.get(instance);
  if (existing) return existing;
  const handle: ResourceHandle = Object.freeze({
    id: `ri-${++counter}` as ResourceInstanceId,
    ref: Object.freeze({ kind, name }),
  });
  handles.set(instance, handle);
  return handle;
}

/** The handle minted for a live instance, if any. */
export function handleOfInstance(instance: object): ResourceHandle | undefined {
  return handles.get(instance);
}
