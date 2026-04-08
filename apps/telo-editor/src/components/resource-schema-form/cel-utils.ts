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

/** Only meaningful on fields already confirmed CEL-eligible via getCelEvalMode. */
export function isCelExpression(value: unknown): boolean {
  return typeof value === "string" && /\$\{\{.*?\}\}/.test(value);
}
