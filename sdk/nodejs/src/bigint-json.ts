/**
 * Reading a wide integer back out of a `JSON.stringify` replacer.
 *
 * CEL models `int` as int64, which this runtime evaluates to a JS BigInt — so
 * `size(group)`, `sum(...)` and integer arithmetic all produce one, and the kernel
 * installs `BigInt.prototype.toJSON` at boot (`enableBigIntJson`,
 * `kernel/nodejs/src/bigint-json.ts`) so every JSON boundary in the process emits
 * it as its exact decimal digits.
 *
 * The installer is a composition-root action and lives in the kernel. What a
 * MODULE AUTHOR needs is the consequence, which is what this file carries: a
 * `toJSON` runs BEFORE a replacer, so a sink or codec that must encode a wide
 * integer differently from the process default can no longer recognise one by
 * `typeof`.
 */

const INSTALLED_KEY = Symbol.for("@telorun/sdk:bigint-json:installed");

/** The process-global flag {@link isBigIntJsonEnabled} reads and the kernel's
 *  installer sets. Shared through `Symbol.for` so a second `@telorun/sdk` copy in
 *  the process (the test suite runs child kernels in-process) sees the first
 *  install rather than re-wrapping. */
export const BIGINT_JSON_INSTALLED_KEY = INSTALLED_KEY;

/** True once the kernel has installed `BigInt.prototype.toJSON` in this process. */
export function isBigIntJsonEnabled(): boolean {
  return (globalThis as Record<symbol, unknown>)[INSTALLED_KEY] === true;
}

/**
 * The BigInt a `JSON.stringify` replacer was called for, or `undefined` when the
 * value is not one.
 *
 * `JSON.stringify` applies `toJSON` BEFORE the replacer, so once the patch is
 * installed a replacer never sees a `bigint` — it sees the opaque raw-JSON token.
 * A serializer that wants a DIFFERENT encoding than the exact digits (OTLP quotes
 * its 64-bit fields; a round-trippable store tags them; a console encoding renders
 * them as text) has to reach past the token, and `JSON.stringify` hands it the
 * means: the replacer is called with the holder as `this`, and the holder still
 * has the original value.
 *
 * Reading the holder also makes the result independent of whether the patch is
 * installed, so an encoder called outside a booted kernel behaves identically.
 *
 * Only reach for this when the default is genuinely wrong for the destination.
 * Everything that wants exact digits on the wire needs no replacer at all.
 */
export function bigIntAt(holder: unknown, key: string): bigint | undefined {
  const source = (holder as Record<string, unknown> | null | undefined)?.[key];
  return typeof source === "bigint" ? source : undefined;
}
