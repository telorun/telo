import type { CompiledValue } from "@telorun/sdk";
import type { Environment } from "@marcbachmann/cel-js";

const TEMPLATE_REGEX = /\$\{\{\s*([^}]+?)\s*\}\}/g;
const EXACT_TEMPLATE_REGEX = /^\s*\$\{\{\s*([^}]+?)\s*\}\}\s*$/;

/**
 * Walks a raw YAML document and replaces all "${{ expr }}" strings with
 * CompiledValue wrappers. Throws on CEL syntax errors.
 * Intended to be called once per document at load time.
 * Telo.Definition documents are returned unchanged — their schema fields
 * are static metadata and must not be treated as CEL templates.
 */
export function precompileDoc(doc: unknown, env: Environment): unknown {
  if (typeof doc === "string") return compileString(doc, env);
  if (Array.isArray(doc)) return doc.map((item) => precompileDoc(item, env));
  // Only recurse into plain objects. Class instances (ResourceInstance, ScopeHandle, etc.)
  // are returned as-is — their prototype methods must not be lost by object reconstruction.
  if (doc !== null && typeof doc === "object" && Object.getPrototypeOf(doc) === Object.prototype) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
      result[k] = precompileDoc(v, env);
    }
    return result;
  }
  return doc;
}

function compileString(s: string, env: Environment): unknown {
  if (!s.includes("${{")) return s;

  const exact = s.match(EXACT_TEMPLATE_REGEX);
  if (exact) {
    const expr = exact[1].trim();
    const fn = env.parse(expr);
    return { __compiled: true, source: expr, call: (ctx: Record<string, unknown>) => fn(ctx) } satisfies CompiledValue;
  }

  // Interpolated template — collect literal parts + compiled sub-expressions
  const parts: Array<string | CompiledValue> = [];
  let last = 0;
  for (const m of s.matchAll(TEMPLATE_REGEX)) {
    if (m.index! > last) parts.push(s.slice(last, m.index));
    const expr = m[1].trim();
    const fn = env.parse(expr);
    parts.push({ __compiled: true, source: expr, call: (ctx: Record<string, unknown>) => fn(ctx) } satisfies CompiledValue);
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
