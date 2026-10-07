import {
  celEvalModeAt,
  celEvalSites,
  declaredEvalMode,
  declaresCelRegion,
  type CelEvalMode,
} from "@telorun/analyzer";
import { isTaggedSentinel, type TaggedSentinel } from "@telorun/templating";
import { pointerToConcretePath } from "../../lib/concrete-path";
import type { JsonSchemaProperty } from "./types";

export type { CelEvalMode };

/**
 * What this field's value is to evaluation: evaluated at load or per
 * invocation, an accessor (named for the resource's consumer, never evaluated),
 * or a literal.
 *
 * Two ways a field becomes CEL-bearing, and reading only the first is what left
 * a `when:` predicate as a bare checkbox: `x-telo-eval` says so directly, while
 * a REGION says so for everything inside it. Both are the analyzer's to define
 * — `declaredEvalMode` and `declaresCelRegion` are its readers — because what
 * this decides is which tags to offer, which is a claim that `telo check` will
 * accept what gets written. Only the DEFAULTING is the form's own: the mode
 * propagates from the enclosing field, which is how a region reaches a
 * descendant that declares nothing.
 *
 * Everything beneath an accessor field is part of that field's value, whatever
 * it declares itself — the analyzer reads nothing below one.
 */
export function getCelEvalMode(
  prop: JsonSchemaProperty,
  rootFallback?: CelEvalMode | null,
): CelEvalMode | null {
  if (rootFallback === "accessor") return "accessor";
  const declared = declaredEvalMode(prop);
  if (declared) return declared;
  if (declaresCelRegion(prop)) return "runtime";
  return rootFallback ?? null;
}

/** Whether `prop` IS an accessor field, rather than a place beneath one: the
 *  field takes one `!cel` chain as its whole value, and nothing below it takes
 *  a tag. */
export function isAccessorField(
  prop: JsonSchemaProperty,
  rootFallback?: CelEvalMode | null,
): boolean {
  return rootFallback !== "accessor" && declaredEvalMode(prop) === "accessor";
}

/**
 * The eval mode in force at `pointer` inside a kind's schema.
 *
 * The detail panel renders a form SCOPED to a pointer, so a region annotation on
 * an ancestor — `Http.Api` anchors `x-telo-context` on the whole `returns:`
 * array — is nowhere in the rendered subtree, and the form has nothing to
 * propagate from. This asks the analyzer the same question it asks of a `!cel`
 * it finds at that path, so the editor offers an expression exactly where
 * `telo check` would accept one.
 *
 * `accessor` for a pointer at or inside an accessor field: every field such a
 * form renders is part of that field's value, so none of them takes a tag.
 */
export function celEvalModeAtPointer(
  kindSchema: JsonSchemaProperty | undefined,
  pointer: string,
): CelEvalMode | null {
  if (!kindSchema) return null;
  return celEvalModeAt(
    celEvalSites(kindSchema as Record<string, unknown>),
    pointerToConcretePath(pointer),
  );
}

/** Convenience type guard for a field renderer that has to distinguish a tagged
 *  value from a plain one without re-importing from `@telorun/templating`.
 *
 *  The `isCelExpression` / `getCelExpressionSource` pair that used to sit beside
 *  it is gone with the CEL toggle: both existed to recognise a raw `${{ }}`
 *  STRING as an expression, and the toggle was the only thing that wrote one —
 *  a spelling manifests must never carry. What a value is written as is now read
 *  off the tag (`value-tag.ts`), which is the only place it is actually
 *  recorded. */
export function getTaggedSentinel(value: unknown): TaggedSentinel | null {
  return isTaggedSentinel(value) ? value : null;
}
