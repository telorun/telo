/**
 * Makes a CEL integer JSON-serializable everywhere, once, for the whole process.
 *
 * CEL models `int` as int64, which this runtime evaluates to a JS BigInt — so
 * `size(group)`, `sum(...)` and integer arithmetic all produce one. `JSON.stringify`
 * THROWS on a BigInt, and there is a JSON boundary at the end of nearly every
 * manifest: an HTTP response body, an NDJSON or SSE frame, a persisted value, an
 * assertion message. Each of those used to answer the question for itself, and the
 * one an author actually meets — an `application/json` response — answered it by
 * throwing, which pushed the answer into the manifest as `double(...)`: a cast that
 * says "make this a float" about a value that is an integer, and that silently loses
 * precision past 2^53.
 *
 * `BigInt.prototype.toJSON` is the sanctioned extension point, and until
 * `JSON.rawJSON` existed it could not be used honestly: `toJSON` must return a JSON
 * *value*, so the only options were a lossy `Number` or a type-changing string.
 * `JSON.rawJSON` emits verbatim text, so a BigInt serializes as its exact decimal
 * digits — legal JSON (the format puts no precision limit on numbers), and already
 * what `fast-json-stringify` emits for a schema-typed `integer`. Installing it is
 * therefore not a new policy; it is what makes the runtime's two JSON serializers
 * agree at every magnitude instead of only below 2^53. Normative statement:
 * `kernel/specs/invocation-contract.md` §4.4.
 *
 * A process-global prototype patch, in the same spirit as the `process.env`
 * guardrail (`host-env.ts`): installed at `boot()`, idempotent across in-process
 * kernels, and non-enumerable so nothing walking `BigInt.prototype` sees it. Every
 * JSON boundary in the process gets it — the kernel's, the standard library's, a
 * third-party module's, and one not yet written.
 *
 * It lives in the kernel rather than the SDK because installing a global is a
 * composition-root action: a controller has no business calling it, and the SDK is
 * the module-author surface. What a module author needs is the consequence —
 * `bigIntAt`, in `@telorun/sdk`, for a sink or codec that must encode a wide
 * integer differently.
 */

import { BIGINT_JSON_INSTALLED_KEY, isBigIntJsonEnabled } from "@telorun/sdk";

/** `JSON.rawJSON` (ES2025). Absent only on a runtime older than this kernel
 *  supports — `engines` pins Node >= 24, and Bun 1.3 has it. */
const rawJSON = (JSON as { rawJSON?: (text: string) => unknown }).rawJSON;

/**
 * Install `BigInt.prototype.toJSON`. Idempotent and process-global.
 *
 * Throws rather than degrading when `JSON.rawJSON` is missing. A quiet no-op would
 * leave every JSON boundary throwing `Do not know how to serialize a BigInt` at
 * some unrelated point later — each site that used to carry its own BigInt handling
 * now relies on this — and nothing in that failure names the runtime as the cause.
 */
export function enableBigIntJson(): void {
  if (isBigIntJsonEnabled()) return;
  if (typeof rawJSON !== "function") {
    throw new Error(
      "JSON.rawJSON is unavailable, so a CEL integer (int64) cannot be serialized " +
        "exactly. Telo requires Node.js >= 24 or Bun >= 1.3.",
    );
  }
  (globalThis as Record<symbol, unknown>)[BIGINT_JSON_INSTALLED_KEY] = true;

  Object.defineProperty(BigInt.prototype, "toJSON", {
    value: function toJSON(this: bigint): unknown {
      return rawJSON(this.toString());
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
}
