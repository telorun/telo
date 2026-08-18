/**
 * "Does this array hold steps, and where does a step keep what the analyzer
 * reads?" — one accessor, the `ref-slot.ts` / `zone-slot.ts` precedent.
 *
 * TWO SPELLINGS, one answer. A kind declares a step body by pointing its items
 * at the shared grammar (`$ref: "telo://manifest#/$defs/Step"`), which fragment
 * expansion stamps `x-telo-fragment: Step`; the field names are then constants
 * of that grammar and nothing states them. Before the fragment existed the shape
 * was each kind's own, so the kind had to say where its dispatch ref, output
 * type and pure-value fields lived — `x-telo-step-context`. That annotation
 * stays READ, permanently: published artifacts carry it and no migration entry
 * can synthesize a `$ref` (the patch vocabulary writes scalars), so it has the
 * standing of the legacy `x-telo-ref` string form.
 *
 * The annotation WINS where both are present. A kind that spells its own shape
 * is describing its own manifest, and a stamp says only which grammar the items
 * point at.
 *
 * Browser-safe: no Node built-ins.
 */

import { manifestFragmentOf } from "./manifest-schemas.js";

/** The name a step-bearing array's items carry once expanded. */
export const STEP_FRAGMENT = "Step";

/** Where a step keeps what the analyzer reads. */
export interface StepSlot {
  /** Field on a step naming the resource to dispatch. */
  invoke: string;
  /** Field on the INVOKED resource's manifest that narrows its result type.
   *  Absent for a composer that allows no per-instance narrowing. */
  outputType?: string;
  /** Field that produces a result without dispatching. Only a grammar with pure
   *  steps has one. */
  value?: string;
}

/** The shared grammar's own field names — constants, since the shape is no
 *  longer the kind's to choose. */
const STEP_FRAGMENT_SLOT: StepSlot = { invoke: "invoke", outputType: "outputType", value: "value" };

/** The step slot an array property declares, or undefined when it holds no
 *  steps. `fieldSchema` is the ARRAY's schema — the stamp sits on its `items`. */
export function readStepSlot(fieldSchema: unknown): StepSlot | undefined {
  if (!fieldSchema || typeof fieldSchema !== "object") return undefined;
  const declared = (fieldSchema as Record<string, unknown>)["x-telo-step-context"];
  if (declared && typeof declared === "object") {
    const { invoke, outputType, value } = declared as Record<string, unknown>;
    if (typeof invoke !== "string" || invoke.length === 0) return undefined;
    return {
      invoke,
      ...(typeof outputType === "string" ? { outputType } : {}),
      ...(typeof value === "string" ? { value } : {}),
    };
  }
  const items = (fieldSchema as Record<string, unknown>).items;
  return manifestFragmentOf(items) === STEP_FRAGMENT ? STEP_FRAGMENT_SLOT : undefined;
}

/** True when the property holds a step body. */
export function isStepSlot(fieldSchema: unknown): boolean {
  return readStepSlot(fieldSchema) !== undefined;
}
