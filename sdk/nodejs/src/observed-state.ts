/**
 * Observed state — what a resource learns while it is running (a socket's
 * actual port, a negotiated endpoint) as opposed to what its author configured.
 *
 * The two are reported through two different channels, because only one of them
 * is derivable on demand:
 *
 *  - **Configured state is pulled.** `snapshot()` returns it, and the kernel
 *    calls that whenever it needs the value; it is a function of the manifest,
 *    so re-deriving it is always correct.
 *  - **Observed state is pushed.** `ResourceContext.setStatus()` reports it at
 *    the moment it is learned, because nothing but the controller knows when
 *    that is. The kernel holds the last value reported and publishes it at
 *    `resources.<name>.{@link OBSERVED_STATE_KEY}.<field>`.
 *
 * Splitting them is what keeps each shape described in exactly one place: a
 * controller never rebuilds observed state inside `snapshot()` from a field it
 * stashed only for that purpose, and the two payloads can never collide.
 */

/** The CEL segment observed state is published under: `resources.<name>.status`. */
export const OBSERVED_STATE_KEY = "status";

/**
 * Copy the plain containers out of a published value so what reaches CEL is a
 * point-in-time reading rather than a live window into the controller.
 *
 * A controller that reported a structure it goes on to mutate would otherwise
 * keep rewriting an already-published value — an accident no schema check can
 * catch, because the shape never changes, only the contents.
 *
 * Plain objects and arrays are rebuilt; everything else — class instances (a
 * `Stream`, a connection pool), functions, primitives — is passed through by
 * reference, because those are not copyable in any meaningful sense and CEL
 * cannot read into them anyway. Cycles resolve to the copy already made.
 */
export function detachSnapshotValue(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const copy: unknown[] = new Array(value.length);
    seen.set(value, copy);
    for (let i = 0; i < value.length; i++) copy[i] = detachSnapshotValue(value[i], seen);
    return copy;
  }
  // Only plain objects: a class instance's identity and behaviour are the point
  // of returning it, and rebuilding one as a bare object would break it.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = detachSnapshotValue(entry, seen);
  }
  return copy;
}
