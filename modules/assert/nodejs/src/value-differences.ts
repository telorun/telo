import { deepEquals } from "./deep-equals.js";

type Segment = string | number;

/** One way `actual` departs from `expected`. `at` is where, `anchor` the
 *  nearest node `expected` itself holds there. */
export interface ValueDifference {
  readonly at: readonly Segment[];
  readonly anchor: readonly Segment[];
  readonly text: string;
}

const MAX_LINES = 10;
const MAX_VALUE_LENGTH = 80;

/**
 * Every difference between two values `deepEquals` refuses, in sorted key order,
 * under the same comparison rules. Never empty for unequal values: what no node
 * accounts for is reported as one difference of the whole value.
 */
export function differencesBetween(actual: unknown, expected: unknown): ValueDifference[] {
  const out: ValueDifference[] = [];
  walk(actual, expected, [], out);
  if (out.length === 0 && !deepEquals(actual, expected)) {
    out.push({ at: [], anchor: [], text: changed(expected, actual) });
  }
  return out;
}

function walk(actual: unknown, expected: unknown, at: Segment[], out: ValueDifference[]): void {
  if (deepEquals(actual, expected)) return;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    const common = Math.min(actual.length, expected.length);
    for (let i = 0; i < common; i++) walk(actual[i], expected[i], [...at, i], out);
    if (actual.length !== expected.length) {
      out.push({ at, anchor: at, text: `expected ${expected.length} items, got ${actual.length}` });
      for (let i = common; i < expected.length; i++) {
        out.push({ at: [...at, i], anchor: [...at, i], text: `missing item ${renderValue(expected[i])}` });
      }
      for (let i = common; i < actual.length; i++) {
        out.push({ at: [...at, i], anchor: at, text: `unexpected item ${renderValue(actual[i])}` });
      }
    }
    return;
  }
  if (isPlainObject(actual) && isPlainObject(expected)) {
    const actualKeys = new Set(Object.keys(actual));
    const expectedKeys = new Set(Object.keys(expected));
    for (const key of [...new Set([...actualKeys, ...expectedKeys])].sort()) {
      if (actualKeys.has(key) && expectedKeys.has(key)) {
        walk(actual[key], expected[key], [...at, key], out);
      } else if (expectedKeys.has(key)) {
        out.push({ at: [...at, key], anchor: [...at, key], text: `missing, expected ${renderValue(expected[key])}` });
      } else {
        out.push({ at: [...at, key], anchor: at, text: `unexpected, got ${renderValue(actual[key])}` });
      }
    }
    return;
  }
  out.push({ at, anchor: at, text: changed(expected, actual) });
}

function changed(expected: unknown, actual: unknown): string {
  return `expected ${renderValue(expected)}, got ${renderValue(actual)}`;
}

/** The report's lines: one per difference, at most ten, then how many more. */
export function differenceLines(differences: readonly ValueDifference[]): string[] {
  const lines = differences
    .slice(0, MAX_LINES)
    .map((difference) => (difference.at.length === 0 ? difference.text : `${pathText(difference.at)}: ${difference.text}`));
  if (differences.length > MAX_LINES) lines.push(`… and ${differences.length - MAX_LINES} more`);
  return lines;
}

/** RFC 6901 pointer to `segments` beneath `root`. */
export function pointerTo(root: string, segments: readonly Segment[]): string {
  return root + segments.map((segment) => `/${String(segment).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

function pathText(segments: readonly Segment[]): string {
  let text = "";
  for (const segment of segments) {
    if (typeof segment === "number") text += `[${segment}]`;
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) text += text === "" ? segment : `.${segment}`;
    else text += `[${JSON.stringify(segment)}]`;
  }
  return text;
}

/**
 * A value as one line: keys sorted, an integer of any size as its digits, a
 * value that is not plain data by what it is, a repeated container as
 * `[Circular]`; cut to `maxLength` characters unless that is `Infinity`.
 */
export function renderValue(value: unknown, maxLength = MAX_VALUE_LENGTH): string {
  const text = render(value, new Set());
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function render(value: unknown, open: Set<object>): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return value.toString();
  const object = value as object;
  if (open.has(object)) return "[Circular]";
  if (Array.isArray(object)) {
    open.add(object);
    const text = `[${object.map((item) => render(item, open)).join(",")}]`;
    open.delete(object);
    return text;
  }
  if (isPlainObject(object)) {
    open.add(object);
    const text = `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${render(object[key], open)}`)
      .join(",")}}`;
    open.delete(object);
    return text;
  }
  if (object instanceof Date) return Number.isNaN(object.getTime()) ? "Date(invalid)" : `Date(${object.toISOString()})`;
  if (object instanceof Map || object instanceof Set) return `${object.constructor.name}(${object.size})`;
  if (ArrayBuffer.isView(object)) return `${object.constructor.name}(${object.byteLength} bytes)`;
  return `<${(object as { constructor?: { name?: string } }).constructor?.name || "object"}>`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
