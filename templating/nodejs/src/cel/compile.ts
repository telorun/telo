import { isCompiledValue, type CompiledValue } from "@telorun/sdk";
import type { ASTNode, Environment } from "@marcbachmann/cel-js";
import { extractAccessChains } from "./analyze.js";
import { CEL_FUNCTIONS } from "./catalog.js";
import { resolveModuleCalls } from "./module-call.js";

export const TEMPLATE_REGEX = /\$\{\{\s*([^}]+?)\s*\}\}/g;
export const EXACT_TEMPLATE_REGEX = /^\s*\$\{\{\s*([^}]+?)\s*\}\}\s*$/;

/** Root variable identifiers an expression reads, from its parsed AST — the
 *  first element of every member-access chain (`self.table` → `self`). Returns
 *  undefined when the parse result carries no AST so consumers can tell "no
 *  refs" from "unknown". */
function rootRefs(ast: ASTNode): readonly string[] {
  const roots = new Set<string>();
  for (const chain of extractAccessChains(ast)) {
    if (chain.length > 0) roots.add(chain[0]!);
  }
  return [...roots];
}

const NON_DETERMINISTIC = new Set(
  CEL_FUNCTIONS.filter((f) => !f.deterministic).map((f) => f.name),
);

/** True when the expression calls a catalog function whose result differs per
 *  call (`uuidv4()`, `nowMillis()`), so evaluating it once and reusing the value
 *  would change what it means. */
function callsNonDeterministic(root: ASTNode): boolean {
  const visit = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(visit);
    if (!node || typeof node !== "object" || !("op" in node)) return false;
    const n = node as ASTNode;
    if ((n.op === "call" || n.op === "rcall") && Array.isArray(n.args)) {
      const name = (n.args as unknown[])[0];
      if (typeof name === "string" && NON_DETERMINISTIC.has(name)) return true;
    }
    const args = n.args as unknown;
    return Array.isArray(args) ? args.some(visit) : visit(args);
  };
  return visit(root);
}

/** Compile a single CEL expression (no `${{ }}` wrapping) into a CompiledValue.
 *  Throws on syntax errors. Used by the `!cel` engine where the entire tagged
 *  scalar is treated as one expression.
 *
 *  `moduleNames` are the declaring module's own names; a call whose receiver is
 *  one of them resolves to a late-bound module call HERE, on the parsed tree, so
 *  every later reader — the root references below, the analyzer's passes, the
 *  kernel's dependency walk — sees the resolved shape rather than re-deriving
 *  it from the source text. */
export function compileExpression(
  expr: string,
  env: Environment,
  moduleNames?: ReadonlySet<string>,
): CompiledValue {
  const fn = env.parse(expr);
  const ast: ASTNode = fn.ast;
  const calls = resolveModuleCalls(ast, moduleNames);
  return {
    __compiled: true,
    source: expr,
    refs: rootRefs(ast),
    calls,
    ...(callsNonDeterministic(ast) ? { volatile: true as const } : {}),
    call: (ctx: Record<string, unknown>) => fn(ctx),
  };
}

/** Compile a string that may contain `${{ }}`-delimited CEL segments. If the
 *  string is exactly one expression, returns a single CompiledValue. If it
 *  contains interpolations, returns a CompiledValue that joins literal parts
 *  with stringified expression results. If no expressions are present, returns
 *  the input string unchanged. Throws on CEL syntax errors. */
export function compileString(
  s: string,
  env: Environment,
  moduleNames?: ReadonlySet<string>,
): unknown {
  if (!s.includes("${{")) return s;

  const exact = s.match(EXACT_TEMPLATE_REGEX);
  if (exact) {
    return compileExpression(exact[1].trim(), env, moduleNames);
  }

  const parts: Array<string | CompiledValue> = [];
  let last = 0;
  for (const m of s.matchAll(TEMPLATE_REGEX)) {
    if (m.index! > last) parts.push(s.slice(last, m.index));
    parts.push(compileExpression(m[1].trim(), env, moduleNames));
    last = m.index! + m[0].length;
  }
  if (last < s.length) parts.push(s.slice(last));

  const refs = new Set<string>();
  const calls = new Set<string>();
  let volatile = false;
  for (const p of parts) {
    if (typeof p === "string") continue;
    if (p.refs) for (const r of p.refs) refs.add(r);
    if (p.calls) for (const c of p.calls) calls.add(c);
    if (p.volatile) volatile = true;
  }

  return {
    __compiled: true,
    source: s,
    parts,
    refs: [...refs],
    calls: [...calls],
    ...(volatile ? { volatile: true as const } : {}),
    call: (ctx: Record<string, unknown>) =>
      parts.map((p) => (typeof p === "string" ? p : String(p.call(ctx) ?? ""))).join(""),
  } satisfies CompiledValue;
}

/** Split an interpolated value into literal fragments and the evaluated values
 *  of its embedded expressions, instead of joining them into one string. Lets a
 *  consumer emit its own placeholders between fragments and bind the values
 *  separately (e.g. parameterized SQL). The invariant
 *  `fragments.length === values.length + 1` always holds.
 *
 *  - plain string (no `${{ }}`)        → `{ fragments: [s], values: [] }`
 *  - bare single expression `${{ x }}` → `{ fragments: ["", ""], values: [x] }`
 *  - interpolated `"a ${{ x }} b"`     → `{ fragments: ["a ", " b"], values: [x] }`
 */
export function toParameterized(
  value: unknown,
  ctx: Record<string, unknown>,
): { fragments: string[]; values: unknown[] } {
  if (typeof value === "string") return { fragments: [value], values: [] };
  if (!isCompiledValue(value)) {
    throw new Error("toParameterized expects a string or CompiledValue");
  }
  if (!value.parts) {
    return { fragments: ["", ""], values: [value.call(ctx)] };
  }
  const fragments: string[] = [];
  const values: unknown[] = [];
  let current = "";
  for (const p of value.parts) {
    if (typeof p === "string") {
      current += p;
    } else {
      fragments.push(current);
      current = "";
      values.push(p.call(ctx));
    }
  }
  fragments.push(current);
  return { fragments, values };
}
