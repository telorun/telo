import { celEvalModeAt, celEvalSites, declaresCelRegion } from "@telorun/analyzer";
import { isTaggedSentinel, type TaggedSentinel } from "@telorun/templating";
import { pointerToConcretePath } from "../../lib/concrete-path";
import type { JsonSchemaProperty } from "./types";

export type CelEvalMode = "compile" | "runtime";

/**
 * Whether this field's value is EVALUATED, and when.
 *
 * Two ways a field becomes CEL-bearing, and reading only the first is what left
 * a `when:` predicate as a bare checkbox: `x-telo-eval` says so directly, while
 * a REGION says so for everything inside it. Both are the analyzer's to define
 * — `declaresCelRegion` is its reader — because what this decides is whether to
 * offer an expression, which is a claim that `telo check` will accept what gets
 * written. Only the DEFAULTING is the form's own: the mode propagates from the
 * enclosing field, which is how a region reaches a descendant that declares
 * nothing.
 */
export function getCelEvalMode(
  prop: JsonSchemaProperty,
  rootFallback?: CelEvalMode | null,
): CelEvalMode | null {
  const annotation = prop["x-telo-eval"];
  if (annotation === "compile" || annotation === "runtime") return annotation;
  if (declaresCelRegion(prop)) return "runtime";
  return rootFallback ?? null;
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
