/**
 * The BigInt-normalized VIEW a JSON Schema validator can check, and merging its
 * default-fills back onto the real value.
 *
 * CEL evaluates an integer to a BigInt, which AJV does not recognise as `integer`
 * or `number` — `typeof data == "number"` is the whole of its type check. So a
 * computed integer reaching a declared integer slot is rejected for a reason the
 * author cannot act on, and cannot fix without casting the value to a float. The
 * value is not wrong; the validator cannot see it.
 *
 * Validating a normalized view rather than coercing in place is what keeps that a
 * validator concern: the dispatched value keeps its BigInts, since a controller may
 * need the full 64-bit range, and serialization emits them exactly (see
 * `enableBigIntJson` in `@telorun/sdk`). A value beyond the safe-integer range loses
 * precision in the VIEW, which can only affect a bound check at the extremes.
 */

import { markExactRendering, UnsignedInt } from "@telorun/sdk";
import type { DataValidationCxt } from "ajv/dist/types/index.js";

/** The validation context of a view: where its root sits, so a root the view
 *  rendered can be marked like any nested one. */
export type ViewContext = DataValidationCxt<string>;

/**
 * The view of `value` and the context to validate it in: `validate(view, context)`.
 * A double the view renders from an integer beyond 2^53 is marked as an exact
 * rendering (`markExactRendering`), which is what lets a range check refuse a
 * NUMBER that wide — a written one is already some other integer — while
 * accepting the rendering of an int64 or a CEL uint that was exact.
 */
export function bigIntView(value: unknown): { view: unknown; context: ViewContext } {
  const holder: Record<string, unknown> = {};
  const view = render(value, holder, "value");
  holder.value = view;
  return {
    view,
    context: {
      instancePath: "",
      parentData: holder,
      parentDataProperty: "value",
      rootData: view as DataValidationCxt["rootData"],
      dynamicAnchors: {},
    },
  };
}

/** A structural copy of `value` with every BigInt rendered as a Number. Returns
 *  the SAME reference when there was nothing to change, which is what lets a
 *  caller skip the merge-back entirely on the common path. Non-plain objects (a
 *  live `Stream`, a resource instance) pass through by reference — they are not
 *  data to be walked. */
export function withBigIntsAsNumbers(value: unknown): unknown {
  return bigIntView(value).view;
}

function render(value: unknown, container: object, key: string | number): unknown {
  // A CEL uint is an integer to JSON Schema — what a `Telo.Uint64` output
  // normalizes to must still pass `type: integer` at the next slot.
  const exact =
    typeof value === "bigint" ? value : value instanceof UnsignedInt ? value.value : undefined;
  if (exact !== undefined) {
    const rendered = Number(exact);
    if (!Number.isSafeInteger(rendered)) markExactRendering(container, key);
    return rendered;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = new Array(value.length);
    let changed = false;
    value.forEach((item, index) => {
      const next = render(item, items, index);
      if (next !== item) changed = true;
      items[index] = next;
    });
    return changed ? items : value;
  }
  if (!value || typeof value !== "object") return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [entryKey, item] of Object.entries(value as Record<string, unknown>)) {
    const next = render(item, out, entryKey);
    if (next !== item) changed = true;
    out[entryKey] = next;
  }
  return changed ? out : value;
}

/** Copy keys an AJV `useDefaults` fill added to `view` back onto `target`.
 *  Only ADDITIONS are taken: a key already present came from the caller and its
 *  original (possibly BigInt) value is the one to keep.
 *
 *  Arrays are walked index-wise, not treated as leaves: AJV writes a default at
 *  every level it finds one, including inside `items`, and `Collection.Sort`'s
 *  `orderBy[].descending` is exactly that shape. Bailing at the array boundary
 *  would drop those fills silently — a worse failure than the throw it replaced,
 *  because the call then succeeds with the default missing. This mirrors the
 *  copy side, where `copyForDefaults` already fans out through an `[]` segment. */
export function mergeFilledDefaults(target: unknown, view: unknown): unknown {
  if (target === view) return target;
  if (!target || typeof target !== "object") return target;
  if (!view || typeof view !== "object") return target;

  if (Array.isArray(target)) {
    if (!Array.isArray(view)) return target;
    for (let i = 0; i < target.length && i < view.length; i++) {
      target[i] = mergeFilledDefaults(target[i], view[i]);
    }
    return target;
  }
  if (Array.isArray(view)) return target;

  const out = target as Record<string, unknown>;
  for (const [key, filled] of Object.entries(view as Record<string, unknown>)) {
    if (!(key in out)) out[key] = filled;
    else out[key] = mergeFilledDefaults(out[key], filled);
  }
  return out;
}
