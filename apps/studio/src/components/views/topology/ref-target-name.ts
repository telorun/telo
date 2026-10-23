import { isResolvedReference } from "@telorun/analyzer";
import { isRefSentinel } from "@telorun/templating";

/** Extracts the referenced resource name from a ref value, across the three
 *  shapes a reference takes: a `!ref <name>` sentinel, a legacy bare/qualified
 *  string name, or a resolved reference (the `__ref`-marked object). Returns
 *  undefined for an inline declaration — any other object, a `name` field
 *  included — and other non-reference values. Also used to normalize
 *  Application `targets` entries, which carry the same `!ref` / string shapes. */
export function refTargetName(value: unknown): string | undefined {
  if (isRefSentinel(value)) return value.source;
  if (typeof value === "string") {
    const lastDot = value.lastIndexOf(".");
    return lastDot > 0 ? value.slice(lastDot + 1) : value;
  }
  if (isResolvedReference(value)) return value.name;
  return undefined;
}
