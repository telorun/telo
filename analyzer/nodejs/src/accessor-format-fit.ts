/**
 * Whether the string an accessor chain names has a format its field takes.
 *
 * A field's `format` constrains the string it holds; an accessor names a value
 * rather than computing one, so the declared schema its chain reads says which
 * formats that value may have. The two are compared by format name alone, a
 * Telo format and a JSON Schema one alike.
 *
 * Browser-safe.
 */
import { shapeNamedBy } from "./referenced-shape.js";
import type { ExternalSchemaResolver } from "./schema-compat.js";

type Schema = Record<string, any>;

const isSchema = (node: unknown): node is Schema =>
  !!node && typeof node === "object" && !Array.isArray(node);

/** `node` read as the shape it names. */
function resolved(node: Schema, external: ExternalSchemaResolver): Schema {
  return typeof node.$ref === "string" ? shapeNamedBy(node, undefined, external) : node;
}

const branchesOf = (node: Schema): unknown[] | undefined =>
  Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined;

/**
 * The formats a slot admits: its `format`, or — for a union every branch of
 * which declares one, directly or through a nested union — those formats.
 * Undefined where the slot does not constrain the format.
 */
export function slotFormats(slot: unknown, external: ExternalSchemaResolver): ReadonlySet<string> | undefined {
  const seen = new Set<object>();
  const visit = (raw: unknown): string[] | undefined => {
    if (!isSchema(raw) || seen.has(raw)) return undefined;
    seen.add(raw);
    const node = resolved(raw, external);
    if (typeof node.format === "string") return [node.format];
    const branches = branchesOf(node);
    if (!branches || branches.length === 0) return undefined;
    const out: string[] = [];
    for (const branch of branches) {
      const formats = visit(branch);
      if (!formats) return undefined;
      out.push(...formats);
    }
    return out;
  };
  const formats = visit(slot);
  return formats ? new Set(formats) : undefined;
}

/** Whether `node` declares only `null`. */
const isNullOnly = (node: Schema): boolean =>
  node.type === "null" || (Array.isArray(node.type) && node.type.length > 0 && node.type.every((t: unknown) => t === "null"));

/** Whether `node` declares a string, and nothing but a string or `null`. */
function isStringNode(node: Schema): boolean {
  if (node.type === "string") return true;
  if (!Array.isArray(node.type)) return false;
  const types = node.type.filter((t: unknown) => t !== "null");
  return types.length === 1 && types[0] === "string";
}

/**
 * The formats a declared string source may have, a string with no `format`
 * read as `undefined` among them; a `null` branch is ignored. Undefined where
 * the source is not a declared string — open, typeless, or another type in any
 * branch.
 */
export function sourceFormats(
  source: unknown,
  external: ExternalSchemaResolver,
): ReadonlyArray<string | undefined> | undefined {
  const seen = new Set<object>();
  const visit = (raw: unknown): (string | undefined)[] | undefined => {
    if (!isSchema(raw) || seen.has(raw)) return undefined;
    seen.add(raw);
    const node = resolved(raw, external);
    const branches = branchesOf(node);
    if (branches && branches.length > 0) {
      const out: (string | undefined)[] = [];
      let nonNull = 0;
      for (const branch of branches) {
        if (isSchema(branch) && isNullOnly(resolved(branch, external))) continue;
        const formats = visit(branch);
        if (!formats) return undefined;
        nonNull++;
        out.push(...formats);
      }
      return nonNull > 0 ? out : undefined;
    }
    if (!isStringNode(node)) return undefined;
    return [typeof node.format === "string" ? node.format : undefined];
  };
  return visit(source);
}

const orList = (names: readonly string[]): string => names.join(" or ");

/**
 * Why the declared source `produced` of an accessor chain may name a string of
 * a format the slot does not take — the clause naming what the source is and
 * what the field takes — or undefined where it fits or nothing decides.
 */
export function accessorFormatMisfit(
  slot: unknown,
  produced: unknown,
  external: ExternalSchemaResolver,
): string | undefined {
  const admitted = slotFormats(slot, external);
  if (!admitted) return undefined;
  const formats = sourceFormats(produced, external);
  if (!formats || formats.every((format) => format !== undefined && admitted.has(format))) return undefined;
  const named = [...new Set(formats.filter((format): format is string => format !== undefined))];
  const unformatted = formats.some((format) => format === undefined);
  const has =
    named.length === 0
      ? "a string with no format"
      : `a string of format ${orList(named)}${unformatted ? " or with no format" : ""}`;
  return `is ${has}; the field takes a string of format ${orList([...admitted])}`;
}
