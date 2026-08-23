import { isRecord } from "../../../lib/utils";
import type { ParsedResource, Selection } from "../../../model";

export { summarizeValue } from "./value-summary";

/**
 * What the focused resource declares, as the rail lists it.
 *
 * The pure half of {@link PropertyRail}: which properties belong on it, what a
 * click selects, and how a value reads in one line. Separate because the
 * SELECTION SHAPE is the load-bearing decision here and it is worth stating
 * once and testing — the rest is a column of buttons.
 */

export interface RailProperty {
  name: string;
  schema: Record<string, unknown>;
  /** The kind declares this property required. */
  required: boolean;
}

/**
 * The kind's own configuration properties, in the order its author declared
 * them, minus the ones the ACTIVE VIEW is rendering.
 *
 * `consumed` comes from the view's own `consumes` declaration rather than from
 * a schema annotation, because "a canvas draws this" is a fact only the view
 * has. Excluding every field carrying an `x-telo-topology-role` was a guess
 * that some view claims it, and a kind annotating an array no view supports
 * would have had that field disappear from the rail without ever appearing on
 * a canvas — unreachable in the editor entirely.
 */
export function railProperties(
  schema: Record<string, unknown>,
  consumed: readonly string[] = [],
): RailProperty[] {
  const properties = schema.properties;
  if (!isRecord(properties)) return [];
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  const drawn = new Set(consumed);
  return Object.entries(properties).flatMap(([name, prop]) =>
    isRecord(prop) && !drawn.has(name)
      ? [{ name, schema: prop, required: required.has(name) }]
      : [],
  );
}

/**
 * What clicking one property selects.
 *
 * Scoped to the RESOURCE with a one-property schema, NOT to `/<name>`. The
 * detail panel's pointer-scoped form edits the object AT the pointer
 * (`pointerTarget` returns null for anything else), so a pointer aimed at a
 * scalar — a `Run.Loop`'s `condition`, its `maxIterations` — resolves to
 * nothing and the panel silently falls back to rendering the whole resource.
 * One property of the root object is the shape that works for every property
 * type alike, and it is what the module root's own form already does.
 *
 * `required` is carried through so the form still marks the field as required;
 * dropping it would make every property look optional the moment it is opened
 * from here.
 */
export function railSelection(
  resource: { kind: string; name: string },
  property: RailProperty,
): Selection {
  return {
    resource: { kind: resource.kind, name: resource.name },
    pointer: "",
    schema: {
      type: "object",
      properties: { [property.name]: property.schema },
      ...(property.required ? { required: [property.name] } : {}),
    },
  };
}

/**
 * Which property the current selection has open, if any.
 *
 * Read BACK off the selection rather than tracked in the rail, so the highlight
 * cannot drift from what the panel is rendering, and a selection made anywhere
 * else moves it too. The signature of a rail selection is exactly what
 * {@link railSelection} emits: scoped to the resource root, carrying one
 * property.
 */
export function focusedProperty(
  selection: Selection | null,
  resource: ParsedResource,
): string | null {
  if (!selection || selection.pointer !== "") return null;
  if (selection.resource.kind !== resource.kind || selection.resource.name !== resource.name) {
    return null;
  }
  const properties = selection.schema.properties;
  if (!isRecord(properties)) return null;
  const keys = Object.keys(properties);
  return keys.length === 1 ? keys[0]! : null;
}
