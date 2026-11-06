/**
 * **What an omitted argument map is judged as** — the one reader of an argument
 * map's `default:`, for the call-site check and the kind check alike.
 *
 * A call's argument map is paired with its target by a reference slot's
 * `x-telo-ref` `inputs:` pointer, or by a step item's property marked
 * `x-telo-topology-role: inputs`. Where the author writes none, the dispatcher
 * sends exactly the `default:` that property declares, so the call site is
 * judged as that literal. A property that may be omitted therefore declares one,
 * as a literal object; a required one is never omitted and needs none.
 *
 * Browser-safe: no Node built-ins.
 */
import type { EnclosedProperty } from "./reference-reach.js";
import { declaredArgumentMaps } from "./reference-reach.js";
import { resolveLocalRef } from "./schema-walk.js";
import { readStepSlot } from "./step-slot.js";
import { topologyRoleOf } from "./topology-role.js";

/** What a paired argument-map property says about an omitted map. */
export type ArgumentMapDefault =
  | { readonly omittable: false }
  | { readonly omittable: true; readonly default: Record<string, any> }
  | { readonly omittable: true; readonly refusal: "undeclared" | "missing" | "not-literal"; readonly written?: unknown };

/** True for a JSON object made of literals alone — no tagged or compiled value
 *  anywhere inside it. */
export function isLiteralObject(value: unknown): value is Record<string, any> {
  return isPlainObject(value) && isLiteral(value);
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isLiteral(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isLiteral);
  if (!isPlainObject(value)) return false;
  if ("__tagged" in value || "__compiled" in value) return false;
  return Object.values(value).every(isLiteral);
}

/** How an omitted map at a property is judged. */
export function readArgumentMapDefault(property: EnclosedProperty): ArgumentMapDefault {
  if (property.required) return { omittable: false };
  if (!property.declared) return { omittable: true, refusal: "undeclared" };
  if (property.default === undefined) return { omittable: true, refusal: "missing" };
  if (!isLiteralObject(property.default)) {
    return { omittable: true, refusal: "not-literal", written: property.default };
  }
  return { omittable: true, default: property.default };
}

/** A step item's argument-map field, and the property it declares. */
export interface StepArgumentMap {
  readonly field: string;
  readonly property: EnclosedProperty;
  /** Where the property is written, relative to `root`, when it is written in it. */
  readonly location?: string;
}

/**
 * The field of a step item marked `x-telo-topology-role: inputs`, with what its
 * declarations say: the item itself and each `oneOf` / `anyOf` / `allOf` branch,
 * local and built-in references followed against `root`. The last field marked
 * is the one a step's arguments are read from.
 */
export function stepArgumentMapOf(
  itemSchema: Record<string, any>,
  root: Record<string, any>,
  itemLocation?: string,
): StepArgumentMap | undefined {
  const candidates: Array<{ node: Record<string, any>; location?: string }> = [];
  const enter = (raw: Record<string, any>, location: string | undefined) => {
    const ref = raw.$ref;
    const node = resolveLocalRef(raw, root) ?? raw;
    const at =
      typeof ref === "string"
        ? ref.startsWith("#/")
          ? ref.slice(2).split("/").join(".")
          : undefined
        : location;
    candidates.push({ node, location: at });
    return { node, at };
  };
  const base = enter(itemSchema, itemLocation);
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const variants = base.node[key];
    if (!Array.isArray(variants)) continue;
    variants.forEach((variant, i) => {
      if (variant && typeof variant === "object") {
        enter(variant as Record<string, any>, base.at === undefined ? undefined : `${base.at}.${key}[${i}]`);
      }
    });
  }
  let field: string | undefined;
  for (const { node } of candidates) {
    for (const [key, sub] of Object.entries((node.properties ?? {}) as Record<string, any>)) {
      if (topologyRoleOf(sub) === "inputs") field = key;
    }
  }
  if (field === undefined) return undefined;
  const property: EnclosedProperty = { declared: false, required: false, default: undefined };
  let location: string | undefined;
  for (const { node, location: at } of candidates) {
    const written = (node.properties as Record<string, any> | undefined)?.[field];
    if (Array.isArray(node.required) && node.required.includes(field)) property.required = true;
    if (!written || typeof written !== "object") continue;
    const target = resolveLocalRef(written, root);
    const value = written.default !== undefined ? written.default : target?.default;
    if (!property.declared) {
      property.declared = true;
      property.node = written;
      location = at === undefined ? undefined : `${at}.properties.${field}`;
    }
    if (property.default === undefined && value !== undefined) property.default = value;
  }
  return { field, property, ...(location !== undefined ? { location } : {}) };
}

/** An argument-map property a kind may let be omitted without declaring the
 *  literal it is judged as. */
export interface ArgumentMapDefaultProblem {
  /** Where, in the kind's `schema`, the property (or the slot pairing it) is
   *  written — relative to the schema. */
  readonly location: string;
  readonly message: string;
}

/** Every paired argument-map property of a kind's own `schema` that may be
 *  omitted and declares no literal object `default:`. */
export function argumentMapDefaultProblems(schema: Record<string, any>): ArgumentMapDefaultProblem[] {
  const out: ArgumentMapDefaultProblem[] = [];
  for (const map of declaredArgumentMaps(schema)) {
    const reading = readArgumentMapDefault(map.property);
    if (!("refusal" in reading)) continue;
    const pairing = `The argument map of the reference slot at '${map.slotLocation}' (its 'inputs: ${map.pointer}')`;
    out.push({
      location: map.propertyLocation ?? map.slotLocation,
      message: problemMessage(pairing, reading),
    });
  }
  const properties = (schema.properties ?? {}) as Record<string, any>;
  for (const [fieldName, fieldSchema] of Object.entries(properties)) {
    if (!readStepSlot(fieldSchema)) continue;
    const items = fieldSchema?.items as Record<string, any> | undefined;
    if (!items || typeof items !== "object") continue;
    const map = stepArgumentMapOf(items, schema, `properties.${fieldName}.items`);
    if (!map) continue;
    const reading = readArgumentMapDefault(map.property);
    if (!("refusal" in reading)) continue;
    out.push({
      location: map.location ?? `properties.${fieldName}.items`,
      message: problemMessage(`The argument map of each step in '${fieldName}' (its '${map.field}')`, reading),
    });
  }
  return out;
}

function problemMessage(
  pairing: string,
  reading: Extract<ArgumentMapDefault, { refusal: string }>,
): string {
  const rule =
    `An omitted argument map is dispatched — and judged — as the default its property declares, ` +
    `so a property that may be omitted declares one, as a literal object (usually 'default: {}'), ` +
    `or lists itself in 'required'.`;
  switch (reading.refusal) {
    case "undeclared":
      return `${pairing} names no property the enclosing object declares, so an omitted map has no default to be judged as. ${rule}`;
    case "missing":
      return `${pairing} may be omitted but declares no 'default:'. ${rule}`;
    case "not-literal":
      return `${pairing} declares 'default: ${describeWritten(reading.written)}', which is not a literal object. ${rule}`;
  }
}

function describeWritten(value: unknown): string {
  if (value && typeof value === "object" && (value as Record<string, unknown>).__tagged === true) {
    const { engine, source } = value as { engine: string; source: string };
    return `!${engine} ${JSON.stringify(source)}`;
  }
  if (value && typeof value === "object" && (value as Record<string, unknown>).__compiled === true) {
    return `an expression`;
  }
  return JSON.stringify(value);
}
