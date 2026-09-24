import { isCompiledValue } from "@telorun/sdk";
import { isTaggedSentinel } from "@telorun/templating";

/**
 * A copy of a JSON Schema with every tagged value — a `!cel` / `!interpolate`
 * sentinel, raw or compiled — reduced to its source text, for AJV to compile.
 *
 * A published kind's `description` may quote `${{ }}` prose, which the
 * `untagged-interpolation` migration reads as `!interpolate`; AJV meta-validates
 * the schema it compiles and refuses an object where a keyword expects a string.
 * One reduction, read by the analyzer's registry and the kernel's validator
 * alike, so the two compile the same schema. Never removes a structural node, so
 * the validator accepts exactly the data it would have.
 */
export function schemaWithTagsAsText(value: unknown): unknown {
  if (isCompiledValue(value) || isTaggedSentinel(value)) {
    return typeof value.source === "string" ? value.source : "";
  }
  if (Array.isArray(value)) return value.map(schemaWithTagsAsText);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = schemaWithTagsAsText(v);
    }
    return out;
  }
  return value;
}
