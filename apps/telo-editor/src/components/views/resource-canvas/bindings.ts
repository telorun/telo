import { collectRefTargets } from "../../resource-schema-form/ref-candidates";
import { isRecord } from "../../../lib/utils";

/** A top-level ref-bearing array on a resource schema, surfaced as a "rack"
 *  row in the right-hand bindings pane of `ResourceCanvas`.
 *
 *  Only collection-shaped refs (arrays of refs, arrays of objects containing
 *  a ref) get a bindings-pane row. Scalar refs — including refs nested inside
 *  top-level objects — are rendered inline in the form pane by
 *  `ReferenceSelectField`, which itself renders as a chip + picker widget.
 *  This keeps the "rack" visual reserved for collections that actually benefit
 *  from it, and avoids the duplicated-editor problem for objects like
 *  `notFoundHandler` that mix a ref sub-field with non-ref siblings.
 */
export interface BindingDescriptor {
  /** Top-level property name — drives row alignment with the form pane. */
  topFieldName: string;
  /** Path from the resource root to the array container. */
  fieldPath: string[];
  /** Title from the top-level schema, falls back to `topFieldName`. */
  title: string;
  /** Description from the top-level schema. */
  description?: string;
  /** Shape dictates the right-pane widget. */
  shape: "array-of-refs" | "array-of-objects";
  /** All candidate `x-telo-ref` targets from the ref field (union of direct +
   *  oneOf/anyOf alternatives). Fed to `resolveRefCandidates` to populate the
   *  target picker. */
  refCapabilities: string[];
  /** Name of the item property that holds the ref — array-of-objects only. */
  refFieldName?: string;
  /** Name of the item's string-typed sibling used as the slot's key label —
   *  array-of-objects only. Absent when the item has no string sibling. */
  keyFieldName?: string;
  /** True when the binding widget already covers every editable part of the
   *  underlying field, so the form-pane can safely hide its control.
   *
   *  - `array-of-refs`: always `true` — items are just refs.
   *  - `array-of-objects`: `true` only when each item is exactly `{ref-child,
   *     optional key string sibling}`. If an item has additional siblings,
   *     they'd be silently uneditable if the form were hidden, so the form
   *     must stay visible alongside the rack. */
  complete: boolean;
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const v = record[key];
  return typeof v === "string" ? v : undefined;
}

/** Finds exactly one `x-telo-ref`-bearing property inside an object schema's
 *  `properties` map, returning its name and collected ref targets. Returns
 *  null if zero or more than one ref-bearing properties exist. */
function findSoleRefChild(
  properties: Record<string, unknown>,
): { name: string; refs: string[] } | null {
  let found: { name: string; refs: string[] } | null = null;
  for (const [name, childProp] of Object.entries(properties)) {
    if (!isRecord(childProp)) continue;
    const refs = collectRefTargets(childProp);
    if (refs.length === 0) continue;
    if (found) return null; // more than one ref child → skip
    found = { name, refs };
  }
  return found;
}

/** First string-typed sibling in schema order, excluding the ref-bearing
 *  property. Returns undefined when no string sibling exists. */
function firstStringSiblingName(
  properties: Record<string, unknown>,
  excludeName: string,
): string | undefined {
  for (const [name, childProp] of Object.entries(properties)) {
    if (name === excludeName) continue;
    if (!isRecord(childProp)) continue;
    if (childProp.type === "string") return name;
  }
  return undefined;
}

/** Walks a resource schema's top-level properties and returns one
 *  `BindingDescriptor` per ref-bearing array, in schema order.
 *
 *  Only `type: array` properties are considered — scalar refs (top-level or
 *  nested) render inline via `ReferenceSelectField` in the form pane.
 *
 *  Array shapes:
 *  - `items.x-telo-ref` (or refs in `oneOf`/`anyOf` of items) → `array-of-refs`.
 *  - `items.type: object` with exactly one ref-bearing child → `array-of-objects`.
 *  - Anything else → skipped; the form pane renders the array normally.
 */
export function discoverBindings(schema: Record<string, unknown>): BindingDescriptor[] {
  const properties = isRecord(schema.properties) ? schema.properties : null;
  if (!properties) return [];

  const descriptors: BindingDescriptor[] = [];

  for (const [topFieldName, rawProp] of Object.entries(properties)) {
    if (!isRecord(rawProp)) continue;
    if (rawProp.type !== "array" || !isRecord(rawProp.items)) continue;

    const title = getString(rawProp, "title") ?? topFieldName;
    const description = getString(rawProp, "description");
    const items = rawProp.items;

    const itemRefs = collectRefTargets(items);
    if (itemRefs.length > 0) {
      descriptors.push({
        topFieldName,
        fieldPath: [topFieldName],
        title,
        description,
        shape: "array-of-refs",
        refCapabilities: itemRefs,
        complete: true,
      });
      continue;
    }

    if (items.type === "object" && isRecord(items.properties)) {
      const refChild = findSoleRefChild(items.properties);
      if (!refChild) continue;
      const keyFieldName = firstStringSiblingName(items.properties, refChild.name);
      const itemSiblingCount = Object.keys(items.properties).length;
      const expectedSiblingCount = 1 + (keyFieldName ? 1 : 0);
      descriptors.push({
        topFieldName,
        fieldPath: [topFieldName],
        title,
        description,
        shape: "array-of-objects",
        refCapabilities: refChild.refs,
        refFieldName: refChild.name,
        keyFieldName,
        complete: itemSiblingCount === expectedSiblingCount,
      });
    }
  }

  return descriptors;
}
