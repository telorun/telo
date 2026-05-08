import type { CompiledValue } from "@telorun/sdk";
import type { Environment } from "@marcbachmann/cel-js";

export const TEMPLATE_REGEX = /\$\{\{\s*([^}]+?)\s*\}\}/g;
export const EXACT_TEMPLATE_REGEX = /^\s*\$\{\{\s*([^}]+?)\s*\}\}\s*$/;

/** Compile a single CEL expression (no `${{ }}` wrapping) into a CompiledValue.
 *  Throws on syntax errors. Used by the `!cel` engine where the entire tagged
 *  scalar is treated as one expression. */
export function compileExpression(expr: string, env: Environment): CompiledValue {
  const fn = env.parse(expr);
  return {
    __compiled: true,
    source: expr,
    call: (ctx: Record<string, unknown>) => fn(ctx),
  };
}

/** Compile a string that may contain `${{ }}`-delimited CEL segments. If the
 *  string is exactly one expression, returns a single CompiledValue. If it
 *  contains interpolations, returns a CompiledValue that joins literal parts
 *  with stringified expression results. If no expressions are present, returns
 *  the input string unchanged. Throws on CEL syntax errors. */
export function compileString(s: string, env: Environment): unknown {
  if (!s.includes("${{")) return s;

  const exact = s.match(EXACT_TEMPLATE_REGEX);
  if (exact) {
    return compileExpression(exact[1].trim(), env);
  }

  const parts: Array<string | CompiledValue> = [];
  let last = 0;
  for (const m of s.matchAll(TEMPLATE_REGEX)) {
    if (m.index! > last) parts.push(s.slice(last, m.index));
    parts.push(compileExpression(m[1].trim(), env));
    last = m.index! + m[0].length;
  }
  if (last < s.length) parts.push(s.slice(last));

  return {
    __compiled: true,
    source: s,
    call: (ctx: Record<string, unknown>) =>
      parts.map((p) => (typeof p === "string" ? p : String(p.call(ctx) ?? ""))).join(""),
  } satisfies CompiledValue;
}
