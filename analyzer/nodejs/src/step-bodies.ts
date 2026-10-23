import { gatherPropertySchemas, resolveLocalRef, walkStepArray } from "./schema-walk.js";
import { readStepSlot } from "./step-slot.js";

/**
 * A declaration's step bodies, found through its kind's step-body slots — the
 * ONLY way a value is read as a step, never its shape. Shared by inline
 * extraction and the scope-reach check, which must agree about where a step's
 * dispatch target is.
 *
 * Browser-safe.
 */

/** One step body of one declaration. */
export interface StepBody {
  /** The field holding it (`steps`). */
  field: string;
  /** The field on each step naming what it dispatches (`invoke`). */
  invokeField: string;
  /** The field on a pure step holding what it produces (`value`), where the
   *  grammar has pure steps. */
  valueField?: string;
  steps: unknown[];
  /** The step item schema, local `$ref` resolved, which says how steps nest. */
  itemSchema: Record<string, any> | undefined;
}

/** Every step body `declaration` holds, per its kind's author-facing `schema`. */
export function stepBodiesOf(
  declaration: Record<string, unknown>,
  schema: Record<string, any>,
): StepBody[] {
  const out: StepBody[] = [];
  const seen = new Set<string>();
  for (const [field, fieldSchema] of gatherPropertySchemas(schema)) {
    const slot = readStepSlot(fieldSchema);
    if (!slot || seen.has(field)) continue;
    const steps = declaration[field];
    if (!Array.isArray(steps)) continue;
    seen.add(field);
    out.push({
      field,
      invokeField: slot.invoke,
      ...(slot.value !== undefined ? { valueField: slot.value } : {}),
      steps,
      itemSchema: resolveLocalRef(fieldSchema.items as Record<string, any> | undefined, schema),
    });
  }
  return out;
}

/** Visit every step of a body at every nesting depth, with its concrete path
 *  (`steps[1].then[0]`). */
export function forEachStep(
  body: StepBody,
  schema: Record<string, any>,
  visit: (step: Record<string, any>, stepPath: string) => void,
): void {
  walkStepArray(body.steps, body.itemSchema, schema, body.field, visit);
}

/** The concrete path of every pure step's value slot in `declaration`, at every
 *  nesting depth (`steps[1].then[0].value`). */
export function stepValueSlotPaths(
  declaration: Record<string, unknown>,
  schema: Record<string, any>,
): string[] {
  const out: string[] = [];
  for (const body of stepBodiesOf(declaration, schema)) {
    const field = body.valueField;
    if (field === undefined) continue;
    forEachStep(body, schema, (step, stepPath) => {
      if (step[field] !== undefined) out.push(`${stepPath}.${field}`);
    });
  }
  return out;
}
