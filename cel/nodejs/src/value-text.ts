/**
 * Text: how a value is written as a string, and how text becomes bytes.
 *
 * `string()` is the one conversion a consumer renders a value through — an interpolated
 * hole is defined as the CEL join of `string(<hole>)` — so each form here is the value's
 * single written form, the same one the plain encoding uses: RFC 3339 for an instant,
 * seconds with an `s` for a duration, UTF-8 text for bytes.
 */

import { celError, type CelError } from "./cel-value.js";
import type { SourceRange } from "./syntax-tree.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** The UTF-8 bytes of text. */
export function textToBytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * The text bytes hold. Bytes that are not UTF-8 are a conversion error rather than text
 * with a replacement character in it: a replacement character is a value the author
 * never wrote, and it would read back as different bytes.
 */
export function bytesToText(bytes: Uint8Array, range?: SourceRange): string | CelError {
  try {
    return decoder.decode(bytes);
  } catch {
    return celError("invalid_conversion", "the bytes are not UTF-8 text", range);
  }
}

/**
 * A double as text. The shortest digits that read back as the same double, which is the
 * host's own shortest-round-trip form; the non-finite doubles are named as cel-spec
 * writes them.
 */
export function doubleText(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  if (value === 0 && Object.is(value, -0)) return "-0";
  return String(value);
}
