import { isTaggedSentinel, type TaggedSentinel } from "@telorun/templating";
import type { JsonSchemaProperty } from "./types";

export type CelEvalMode = "compile" | "runtime";

export function getCelEvalMode(
  prop: JsonSchemaProperty,
  rootFallback?: CelEvalMode | null,
): CelEvalMode | null {
  const annotation = prop["x-telo-eval"];
  if (annotation === "compile" || annotation === "runtime") return annotation;
  return rootFallback ?? null;
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
