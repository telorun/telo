import type { Operator } from "./collection-source.js";
import { plainTypes, type JsonSchema } from "./model-schema.js";

/** How a value is entered: `Ui.Control`, plus a filter bar's `none`. */
export type Control = "auto" | "select" | "options" | "toggle" | "slider" | "tags" | "none";

const SCALARS = ["string", "number", "integer", "boolean"];
const SINGLE = ["eq", "gt", "gte", "lt", "lte"];

const isNode = (value: unknown): value is JsonSchema => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Whether a control can enter a property — the twin of the `Ui.controlFits`
 * function, held to the same rows (`conformance/control-fits.json`).
 * `operator` is a filter's, or `null` for a form field, whose value is a list
 * when the property is an `array` and is entered by its `items` then. A field's
 * property holds one plain value or a list of them, whatever its control.
 * `absent` holds whether the property is missing, entered with a toggle.
 */
export function controlFits(control: Control, property: JsonSchema, operator: Operator | null): boolean {
  if (operator === "absent") return control === "auto" || control === "toggle" || control === "none";
  const listed = operator === null && plainTypes(property).join() === "array";
  const element = !listed ? property : isNode(property.items) ? property.items : {};
  const types = plainTypes(element);
  const plain = types.length === 0 ? Array.isArray(element.enum) : types.every((type) => SCALARS.includes(type));
  if (operator === null && !plain) return false;
  switch (control) {
    case "auto":
      return plain;
    case "select":
    case "options":
      return Array.isArray(element.enum) || types.join() === "boolean";
    case "toggle":
      return types.join() === "boolean" && (operator === null ? !listed : operator === "eq");
    case "slider":
      return (
        types.length > 0 &&
        types.every((type) => type === "number" || type === "integer") &&
        element.minimum !== undefined &&
        element.maximum !== undefined &&
        (operator === null ? !listed : SINGLE.includes(operator))
      );
    case "tags":
      return operator === null ? listed : operator === "in";
    case "none":
      return operator !== null;
  }
}
