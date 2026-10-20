import { isRefSentinel } from "@telorun/templating";

/** Extracts the referenced resource name from a ref value, across the three
 *  shapes a ref slot can hold: a `!ref <name>` sentinel, a bare/qualified
 *  string name, or a `{kind, name}` object. Returns undefined for inline
 *  resources and other non-reference values. Also used to normalize Application
 *  `targets` entries, which carry the same `!ref` / string shapes. */
export function refTargetName(value: unknown): string | undefined {
  if (isRefSentinel(value)) return value.source;
  if (typeof value === "string") {
    const lastDot = value.lastIndexOf(".");
    return lastDot > 0 ? value.slice(lastDot + 1) : value;
  }
  if (value && typeof value === "object") {
    const name = (value as Record<string, unknown>).name;
    if (typeof name === "string") return name;
  }
  return undefined;
}
