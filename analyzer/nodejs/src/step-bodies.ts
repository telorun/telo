import { reachSites } from "./reference-reach.js";
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

/**
 * Where a declaration holds its pure steps' `value:` — its own step bodies and
 * those of every resource declared in one of its scopes (`with:`), each read over
 * the schema of the kind that owns it, spelled as the body walkers spell paths
 * (`with[0].steps[1].value`). The kernel leaves these compiled for the step
 * engine, and `telo check` types `self` there as the kernel binds it.
 */
export function stepValueSlots(
  declaration: Record<string, unknown>,
  schema: Record<string, any>,
  schemaOfKind: (kind: string) => Record<string, any> | undefined,
): string[] {
  const slots = stepValueSlotPaths(declaration, schema);
  for (const site of reachSites(schema, declaration)) {
    if (site.scopes.length === 0 || !Array.isArray(site.data)) continue;
    const at = pathOfKeys(site.keys);
    site.data.forEach((member, i) => {
      if (member === null || typeof member !== "object") return;
      const kind = (member as { kind?: unknown }).kind;
      const memberSchema = typeof kind === "string" ? schemaOfKind(kind) : undefined;
      if (!memberSchema) return;
      for (const slot of stepValueSlots(member as Record<string, unknown>, memberSchema, schemaOfKind)) {
        slots.push(`${at}[${i}].${slot}`);
      }
    });
  }
  return slots;
}

/** True when `path` is one of `slots` or lies beneath one. */
export function isWithinSlot(slots: readonly string[], path: string): boolean {
  return slots.some(
    (slot) => path === slot || path.startsWith(`${slot}.`) || path.startsWith(`${slot}[`),
  );
}

function pathOfKeys(keys: readonly (string | number)[]): string {
  let path = "";
  for (const key of keys) {
    if (typeof key === "number") path += `[${key}]`;
    else path += path ? `.${key}` : key;
  }
  return path;
}
