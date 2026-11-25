/**
 * An instance value as a JSON Schema validator sees it: opaque.
 *
 * Bytes, a timestamp, a duration, a CEL type, an optional and a host's own typed value
 * (a built URL) are values of the value domain, not JSON containers. To a schema they
 * are an object to `type`, equal only to an equal value of their own type under
 * `const` / `enum` / `uniqueItems`, and hold no own entries for any other keyword —
 * `x-telo-type` alone reads them. A validator's view substitutes each with a stand-in
 * that says exactly that, so a keyword cannot read a value's representation (a
 * timestamp's `seconds`, a byte array's indices), and every runtime validating a value
 * answers alike.
 *
 * A uint is not opaque: a view renders it as the number it is. Nor is a map with
 * non-string keys, which is data.
 */

import { CEL_VALUE_TYPE } from "@telorun/cel";

const HELD: unique symbol = Symbol.for("telo.schema.opaque") as never;

/** Value-domain keys that are not instance values to a schema. */
const NOT_INSTANCE_KEYS: ReadonlySet<string> = new Set(["uint", "map", "error"]);

/** Whether `value` is an instance value a validator's view presents opaque. */
export function isSchemaInstanceValue(value: unknown): boolean {
  if (value instanceof Uint8Array) return true;
  if (!value || typeof value !== "object") return false;
  const key = (value as { [CEL_VALUE_TYPE]?: unknown })[CEL_VALUE_TYPE];
  return typeof key === "string" && !NOT_INSTANCE_KEYS.has(key);
}

/** A stand-in holding an instance value: no own entries, equal to a stand-in of an
 *  equal value through its `valueOf`. */
class OpaqueSchemaValue {
  declare readonly [HELD]: unknown;

  constructor(held: unknown) {
    Object.defineProperty(this, HELD, { value: held, enumerable: false });
  }

  valueOf(): string {
    return identityText(this[HELD]);
  }
}

/** The stand-in a view holds in place of the instance value `value`. */
export function opaqueSchemaValue(value: unknown): object {
  return new OpaqueSchemaValue(value);
}

/** Whether `value` is a view's stand-in. */
export function isOpaqueSchemaValue(value: unknown): boolean {
  return !!value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, HELD);
}

/** The instance value a stand-in holds, or `value` itself. The `x-telo-type` keyword
 *  reads a value through this. */
export function schemaHeldValue(value: unknown): unknown {
  return isOpaqueSchemaValue(value) ? (value as OpaqueSchemaValue)[HELD] : value;
}

/** `value` with every instance value beneath plain containers replaced by its
 *  stand-in — the same reference when there was nothing to replace. */
export function opaqueSchemaView(value: unknown): unknown {
  if (isSchemaInstanceValue(value)) return opaqueSchemaValue(value);
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = opaqueSchemaView(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : value;
  }
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  if ((value as { [CEL_VALUE_TYPE]?: unknown })[CEL_VALUE_TYPE] !== undefined) return value;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const next = opaqueSchemaView(item);
    if (next !== item) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
}

/** What identifies an instance value under equality: its type and its content. */
function identityText(value: unknown): string {
  if (value instanceof Uint8Array) {
    let hex = "";
    for (const byte of value) hex += byte.toString(16).padStart(2, "0");
    return `bytes:${hex}`;
  }
  const key = (value as { [CEL_VALUE_TYPE]?: unknown })[CEL_VALUE_TYPE];
  return `${String(key)}:${entriesText(value as Record<string, unknown>)}`;
}

function entriesText(value: Record<string, unknown>): string {
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${contentText(v)}`).join(",")}}`;
}

function contentText(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  if (isSchemaInstanceValue(value)) return identityText(value);
  if (Array.isArray(value)) return `[${value.map(contentText).join(",")}]`;
  if (value && typeof value === "object") return entriesText(value as Record<string, unknown>);
  return JSON.stringify(value) ?? String(value);
}
