import type { GraphDimension } from "@telorun/editor-protocol";

/** A dimension value as a picker option: its JSON text identifies it (a select
 *  holds strings), and a person reads it as itself — `null`, the absence of an
 *  input, as "absent". */
export function optionOf(value: unknown): { id: string; label: string } {
  return {
    id: JSON.stringify(value),
    label: value === null ? "absent" : typeof value === "string" ? value : JSON.stringify(value),
  };
}

/** `selected` with `dimension` moved to the option `id`. */
export function withPick(
  selected: Record<string, unknown>,
  dimension: GraphDimension,
  id: string,
): Record<string, unknown> {
  const at = dimension.values.findIndex((v) => JSON.stringify(v) === id);
  return at < 0 ? selected : { ...selected, [dimension.key]: dimension.values[at] };
}
