import type { CompiledValue } from "@telorun/sdk";
import { ParseError, type ASTNode, type Environment } from "@marcbachmann/cel-js";
import { extractAccessChains } from "./analyze.js";
import { CEL_FUNCTIONS } from "./catalog.js";
import { resolveModuleCalls } from "./module-call.js";

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

/** True when the expression calls a method on a bare identifier (`Billing.f(x)`).
 *  Whether that identifier names a module is the declaring module's to say, and
 *  the text alone does not, so every such call may be a module call. */
function callsOnBareReceiver(root: ASTNode): boolean {
  const visit = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(visit);
    if (!node || typeof node !== "object" || !("op" in node)) return false;
    const n = node as ASTNode;
    if (n.op === "rcall" && Array.isArray(n.args)) {
      const receiver = (n.args as unknown[])[1] as { op?: unknown } | null;
      if (receiver && typeof receiver === "object" && receiver.op === "id") return true;
    }
    const args = n.args as unknown;
    return Array.isArray(args) ? args.some(visit) : visit(args);
  };
  return visit(root);
}

/**
 * Whether an expression's text, written twice in one value, means one value
 * both times: it calls no catalog function whose result differs per call, and
 * makes no call that may be a module's — a module function's determinism is its
 * callee's, which the text does not say. Text that does not parse means no
 * value, so it is not repeatable; `analyze` is what reports why.
 */
export function repeatableExpression(expr: string, env: Environment): boolean {
  let ast: ASTNode;
  try {
    ast = env.parse(expr).ast;
  } catch (error) {
    if (error instanceof ParseError) return false;
    throw error;
  }
  return !callsNonDeterministic(ast) && !callsOnBareReceiver(ast);
}

/** Compile a single CEL expression into a CompiledValue. Throws on syntax
 *  errors. The `!cel` engine compiles its whole scalar with it, and the tags
 *  with holes compile each hole.
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
