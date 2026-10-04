/**
 * `Duration` and `UnsignedInt` — the classes the value domain replaced, kept as shims so a
 * controller PUBLISHED against them still loads.
 *
 * **Why they cannot simply be removed.** `@telorun/sdk` is external to a controller bundle
 * and collapsed to the running kernel's own copy, so a module's published artifact imports
 * whatever SDK the kernel carries. Removing a name therefore breaks every artifact already in
 * a user's lock file, with a `SyntaxError` at load — `Export named 'Duration' not found` —
 * which no `requires: telo:` floor can prevent, because the floor would have to have been
 * declared in an artifact that is already published. Measured: `record-stream@0.18.0` and
 * `@0.19.0` import `Duration`, and every app importing either failed to boot.
 *
 * **A shim produces a value in the DOMAIN, not an instance of a class.** `fromMilliseconds`
 * returns the branded value `celDurationFromNanos` builds, so what a published controller
 * hands onward is a real CEL duration that the typed frame, the plain encoding and every
 * `isCelDuration` reader accept. The compatibility is in the two things the old surface
 * offered and the brand does not:
 *
 * - `instanceof Duration` answers through `Symbol.hasInstance`, which is `isCelDuration` — so
 *   the published `instanceof` test still answers true, for a branded value it did not build
 *   as well as one it did.
 * - `getMilliseconds()` is defined on the value as a **non-enumerable** own property, so it
 *   is reachable by the published code and invisible to every walk that reads a value by its
 *   entries. An enumerable one would appear in a plain-JSON encoding and in the typed frame.
 *
 * `Duration` is measured — two published artifacts import it. **`UnsignedInt` is
 * precautionary: nothing in this workspace's module cache references it.** It is shimmed
 * because it was an exported name that was removed, which is the same hazard whether or not
 * an artifact here happens to show it, and the shim costs a few lines; it is not a claim that
 * a consumer was found.
 *
 * Deprecated on arrival. A module is migrated to `celDurationFromNanos` / `durationNanos` /
 * `isCelDuration` and `celUint` / `isCelUint` as it is touched, never in bulk — the shims
 * exist for artifacts nobody can go back and edit.
 */
import {
  celDurationFromNanos,
  celUint,
  durationNanos,
  isCelDuration,
  isCelUint,
  type CelDuration,
  type CelUint,
} from "@telorun/cel";

const NANOS_PER_MILLISECOND = 1_000_000n;

/**
 * A duration carrying the one method the replaced class exposed.
 *
 * **Applied wherever a duration can reach a controller, not only where the shim built one.**
 * The published guard is `if (!(value instanceof Duration)) throw …; return
 * value.getMilliseconds()`, so BOTH have to hold for a duration decoded from a manifest slot
 * — a value the shim never saw. Answering `instanceof` without the method only converts the
 * crash into that function's own `ERR_INVALID_VALUE`, which is no better.
 */
export function withLegacyDurationMethods(value: CelDuration): CelDuration {
  Object.defineProperty(value, "getMilliseconds", {
    value: () => Number(durationNanos(value) / NANOS_PER_MILLISECOND),
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return value;
}

/**
 * @deprecated The value domain replaced this class. Build with `celDurationFromNanos`, read
 * with `durationNanos`, and ask with `isCelDuration`.
 */
export const Duration = {
  fromMilliseconds(milliseconds: number | bigint): CelDuration {
    const ms = typeof milliseconds === "bigint" ? milliseconds : BigInt(Math.trunc(milliseconds));
    // The builder range-checks and answers an error value; the replaced class threw, so the
    // shim throws rather than handing a published controller something it cannot read.
    const built = celDurationFromNanos(ms * NANOS_PER_MILLISECOND);
    if (!isCelDuration(built)) {
      throw new RangeError(`Duration.fromMilliseconds: ${milliseconds} is outside the range`);
    }
    return withLegacyDurationMethods(built);
  },
  [Symbol.hasInstance](value: unknown): boolean {
    return isCelDuration(value);
  },
};

/**
 * @deprecated The value domain replaced this class. Build with `celUint` and ask with
 * `isCelUint`.
 */
export const UnsignedInt = {
  from(value: number | bigint): CelUint {
    return celUint(typeof value === "bigint" ? value : BigInt(Math.trunc(value)));
  },
  [Symbol.hasInstance](value: unknown): boolean {
    return isCelUint(value);
  },
};
