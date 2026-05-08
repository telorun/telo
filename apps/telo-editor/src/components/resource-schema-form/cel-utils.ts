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

/** True when the field's runtime value carries a CEL expression — either the
 *  untagged `${{ ... }}` interpolated form, or the explicit `!cel`-tagged
 *  sentinel produced by the YAML loader. `!literal`-tagged values return
 *  false: they are intentionally inert text, not expressions. */
export function isCelExpression(value: unknown): boolean {
  if (typeof value === "string") return /\$\{\{.*?\}\}/.test(value);
  if (isTaggedSentinel(value)) return value.engine === "cel";
  return false;
}

/** Returns the editable source text for any value that wraps text via the
 *  templating system — untagged `${{ ... }}` strings, `!cel`-tagged
 *  sentinels, and `!literal`-tagged sentinels. Returns null for plain
 *  primitives without any expression markup so callers can fall through to
 *  the regular field UI. The wrapper distinguishes which chrome to render
 *  (CEL editor vs. literal-text display) using `isCelExpression` /
 *  `getTaggedSentinel` separately. */
export function getCelExpressionSource(value: unknown): string | null {
  if (typeof value === "string") return /\$\{\{.*?\}\}/.test(value) ? value : null;
  if (isTaggedSentinel(value)) return value.source;
  return null;
}

/** Convenience type guard re-exported for the wrapper, so it can pick chrome
 *  based on the engine without re-importing from `@telorun/templating`. */
export function getTaggedSentinel(value: unknown): TaggedSentinel | null {
  return isTaggedSentinel(value) ? value : null;
}
