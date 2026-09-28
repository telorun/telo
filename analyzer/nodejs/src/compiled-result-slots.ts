import {
  collectProperties,
  fittingUnionBranches,
  resolveRefIn,
  selectUnionBranch,
  type ExternalSchemaResolver,
} from "./schema-compat.js";

/**
 * Where each compile-eval expression's RESULT lands, and the schema of the slot
 * it fills.
 *
 * A resource (and the root Application's `logging:` / `tracing:` blocks) is
 * validated while its expressions are still expressions, so an expression is
 * checked only as a stand-in. Once they are evaluated, each result is held to
 * its slot's schema — a `dyn` expression passes `telo check`, and the value it
 * produces must still be what the slot declares. This walk pairs the value as
 * written (to find the expressions, and to choose a union branch the way the
 * other walks do) with the value as evaluated.
 */
export interface CompiledResultSlot {
  /** Path segments from the walked value's root: keys and list indices. */
  segments: (string | number)[];
  /** The slot's schema, with a union left whole so the result may take any branch. */
  schema: Record<string, any>;
  /** The document the slot's own `$ref`s resolve against. */
  root: Record<string, any>;
  /** What the expression produced. */
  value: unknown;
}

export function compiledResultSlots(
  written: unknown,
  evaluated: unknown,
  schema: Record<string, any>,
  isExpression: (node: unknown) => boolean,
  external?: ExternalSchemaResolver,
  rootSchema: Record<string, any> = schema,
): CompiledResultSlot[] {
  const slots: CompiledResultSlot[] = [];
  const walk = (
    node: unknown,
    result: unknown,
    raw: Record<string, any>,
    base: Record<string, any>,
    segments: (string | number)[],
  ): void => {
    const entered = resolveRefIn(raw, base, external);
    if (isExpression(node)) {
      // Still an expression: a runtime-evaluated slot, whose value the
      // evaluation that reads it is responsible for.
      if (!isExpression(result)) {
        slots.push({ segments, schema: entered.schema, root: entered.root, value: result });
      }
      return;
    }
    if (!node || typeof node !== "object" || !result || typeof result !== "object") return;
    // A union whose branch the written value does not decide is never guessed:
    // the whole evaluated subtree is held to the whole union, so a result any
    // branch accepts passes. A subtree still holding runtime expressions cannot
    // be judged whole yet, and is left to the evaluation that reads it.
    const fits = fittingUnionBranches(entered.schema, node, entered.root, external);
    if (fits && fits.length !== 1) {
      if (holdsExpression(node, isExpression) && !holdsExpression(result, isExpression)) {
        slots.push({ segments, schema: entered.schema, root: entered.root, value: result });
      }
      return;
    }
    const selected = selectUnionBranch(entered.schema, node, entered.root, external);
    const { schema: here, root } = resolveRefIn(selected, entered.root, external);
    if (here["x-telo-ref"] !== undefined) return;

    if (Array.isArray(node)) {
      if (!Array.isArray(result)) return;
      const items = (here.items ?? {}) as Record<string, any>;
      node.forEach((item, i) => walk(item, result[i], items, root, [...segments, i]));
      return;
    }
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) return;
    const properties = collectProperties(here);
    const additional =
      here.additionalProperties && typeof here.additionalProperties === "object"
        ? (here.additionalProperties as Record<string, any>)
        : undefined;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const slot = properties[key] ?? additional;
      if (slot) walk(child, (result as Record<string, unknown>)[key], slot, root, [...segments, key]);
    }
  };
  walk(written, evaluated, schema, rootSchema, []);
  return slots;
}

function holdsExpression(value: unknown, isExpression: (node: unknown) => boolean): boolean {
  if (isExpression(value)) return true;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => holdsExpression(item, isExpression));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value as Record<string, unknown>).some((v) => holdsExpression(v, isExpression));
}

/** `tracing.sinks[0].when` — how a message names a path. */
export function formatSlotPath(segments: readonly (string | number)[]): string {
  return segments
    .map((s, i) => (typeof s === "number" ? `[${s}]` : i === 0 ? s : `.${s}`))
    .join("");
}
