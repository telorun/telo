/**
 * `x-telo-context-from-path-template: "<relative pointer>"` — on a binding of an
 * `x-telo-context`, or a member beneath one: the node is the variables of the
 * path template the resource holds at the pointer — a CLOSED object with one
 * required string property per `{name}` segment. A page's `params` is the
 * variables of its own `path`.
 *
 * The pointer is a Relative JSON Pointer anchored at the context holder — the
 * object holding the field the region is declared on, the item itself for a
 * region declared on a list's items — in `x-telo-context-element-from-item`'s
 * grammar (`0/path`). A template is read by `x-telo-path-params-for`'s grammar
 * (`readPathTemplate`). Where the field holds no template — absent, an
 * expression, a malformed one — the node is an open map of strings.
 *
 * This file is the one reader of the value, of the type it gives and of its
 * strict half (`validate-match-for.ts` reports it). The scope rule applies it
 * (`cel-scope.ts`). Analyzer-only: the kernel reads no context.
 *
 * Browser-safe: no Node built-ins.
 */
import { isCompiledValue } from "@telorun/sdk";
import { isTaggedSentinel } from "@telorun/templating";
import { TYPING_ANNOTATIONS } from "./context-from-referrer.js";
import { holderPointerTarget, type DataToken } from "./context-nullable-when.js";
import { readRelativePointer, type RelativePointer, type SchemaLevel } from "./element-from-item.js";
import type { NamedShapeLookup } from "./eval-paths.js";
import { readPathTemplate } from "./path-params-slot.js";
import { enclosingKeys, placeAt, type ReadPlace, type ReadReporter } from "./read-place.js";

export const CONTEXT_FROM_PATH_TEMPLATE = "x-telo-context-from-path-template";

type Schema = Record<string, any>;

const isSchema = (node: unknown): node is Schema => !!node && typeof node === "object" && !Array.isArray(node);

/** The pointer `node` names its template by, or undefined — also for a
 *  malformed value, which the strict half reports. */
export function readFromPathTemplate(node: unknown): RelativePointer | undefined {
  return isSchema(node) ? readRelativePointer(node[CONTEXT_FROM_PATH_TEMPLATE]) : undefined;
}

/** The keywords that shape an object, which the typing replaces. */
const SHAPE_KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "patternProperties", "propertyNames"]);

/**
 * The type of a node annotated on `own`, for the value `template` the pointer
 * reaches: one required string per variable of a template, closed; an open map
 * of strings for anything that is no template.
 */
export function pathTemplateParams(own: Schema, template: unknown): Schema {
  const kept = Object.fromEntries(
    Object.entries(own).filter(([key]) => key !== CONTEXT_FROM_PATH_TEMPLATE && !SHAPE_KEYWORDS.has(key)),
  );
  const reading = typeof template === "string" ? readPathTemplate(template) : undefined;
  if (!reading || !("variables" in reading)) {
    return { ...kept, type: "object", additionalProperties: { type: "string" } };
  }
  return {
    ...kept,
    type: "object",
    properties: Object.fromEntries(reading.variables.map((name) => [name, { type: "string" }])),
    required: [...reading.variables],
    additionalProperties: false,
  };
}

/** The value `pointer` names from a holder at `holder` in `root`, or undefined
 *  where it climbs above the root, crosses no container or holds an
 *  expression. */
export function valueFromHolder(root: unknown, holder: readonly DataToken[], pointer: RelativePointer): unknown {
  if (pointer.up > holder.length) return undefined;
  const computed = (value: unknown) => isTaggedSentinel(value) || isCompiledValue(value);
  let current: unknown = root;
  for (const token of [...holder.slice(0, holder.length - pointer.up), ...pointer.segments]) {
    if (current === null || typeof current !== "object" || computed(current)) return undefined;
    current = (current as Record<string | number, unknown>)[token];
  }
  return computed(current) ? undefined : current;
}

export type FromPathTemplateProblem =
  | { readonly code: "SCHEMA_VIOLATION"; readonly message: string }
  | { readonly code: "CONTEXT_FROM_PATH_TEMPLATE_INVALID"; readonly message: string };

/**
 * Why the annotation on `node` is malformed or misplaced, or undefined. `where`
 * names it as the diagnostic does; `field` is the instance-level walk to the
 * field its region is declared on when `node` is a binding or a member beneath
 * one (undefined where the walk cannot tell), `inBinding` whether it is one.
 */
export function fromPathTemplateProblem(
  node: Schema,
  where: string,
  inBinding: boolean,
  field: readonly SchemaLevel[] | undefined,
  document: Schema,
  shapes: NamedShapeLookup,
  rootIsResource: boolean,
): FromPathTemplateProblem | undefined {
  const written = node[CONTEXT_FROM_PATH_TEMPLATE];
  const pointer = readRelativePointer(written);
  if (!pointer) {
    return {
      code: "SCHEMA_VIOLATION",
      message:
        `'${where}' must be a relative JSON pointer — the levels to climb from the context holder, then a ` +
        `JSON Pointer to the field holding the path template ('0/path').`,
    };
  }
  if (!inBinding) {
    return {
      code: "CONTEXT_FROM_PATH_TEMPLATE_INVALID",
      message: `'${where}' is read only on a binding — a property of an 'x-telo-context' — or a member beneath one, so here it types nothing.`,
    };
  }
  // `x-telo-context-from-referrer` beside it is that annotation's own refusal.
  const beside = TYPING_ANNOTATIONS.find((key) => key !== CONTEXT_FROM_PATH_TEMPLATE && key in node);
  if (beside) {
    return {
      code: "CONTEXT_FROM_PATH_TEMPLATE_INVALID",
      message: `'${where}' types the node from a path template, and '${beside}' beside it types it too; keep one.`,
    };
  }
  if (!field) return undefined;
  const found = holderPointerTarget(field, pointer, document, shapes, rootIsResource);
  const refusal = "refusal" in found ? found.refusal : holdsNoString(found.target);
  if (!refusal) return undefined;
  return {
    code: "CONTEXT_FROM_PATH_TEMPLATE_INVALID",
    message: `'${where}: ${String(written)}' names no path template to type the node from: ${refusal}.`,
  };
}

/** Why a field declared by `target` can never hold a template, or undefined. */
function holdsNoString(target: Schema): string | undefined {
  const type = target.type;
  const types = typeof type === "string" ? [type] : Array.isArray(type) ? type : undefined;
  return types && !types.includes("string") ? `the field is declared ${types.join(" or ")}, never a string` : undefined;
}

/** What `x-telo-context-from-path-template` reads: the value at its pointer,
 *  from the object holding the region's field — the item, for a region on a
 *  list. */
export const fromPathTemplateReads: ReadReporter = ({ value, at, item }) => {
  if (typeof value !== "string" || !readRelativePointer(value)) return [];
  const seen = new Set<string>();
  const out: ReadPlace[] = [];
  for (const base of [enclosingKeys(at), item]) {
    const keys = placeAt(base, value);
    const id = JSON.stringify(keys);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ kind: "value", keys });
  }
  return out;
};
