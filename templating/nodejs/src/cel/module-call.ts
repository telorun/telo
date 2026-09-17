/**
 * **A call whose receiver is one of the declaring module's names.**
 *
 * `Billing.format(x)`, `Self.y(1)`, `<ModuleName>.y(1)` — CEL's own
 * qualified-function rule, the one `cel.bind` and cel-go's `math.greatest`
 * already follow. Resolution happens on the PARSED TREE, right after
 * `env.parse` and before any check: the author's text, spans and the expression
 * a trace shows stay exactly as written, which rewriting the source would move.
 *
 * A module's names are known from its own file before any import resolves — its
 * `imports:` keys, `Self`, its `metadata.name` and `Telo` — so the set is an
 * INPUT here rather than something this module derives. A call on a bare
 * identifier outside the set stays an ordinary method call, which is what keeps
 * the catalog's `format` and `Billing.format` from ever colliding, with one
 * catalog environment compiling both.
 *
 * Two engine internals carry it, neither exposed by cel-js's typings — hence
 * the exact version pin and `tests/module-call.test.ts`, which fails the moment
 * an upgrade moves either:
 *
 *  - `ASTNode.setMeta('macro', …)` redirects a node's check and evaluation. A
 *    comprehension macro (`map`, `filter`, …) sets `alternate` instead, and
 *    `alternate` WINS over `macro`, so a call the parser expanded as a macro
 *    needs it cleared or the rewrite is silently ignored. The parser expands
 *    those names BEFORE this rewrite and refuses any call whose arguments do not
 *    fit the macro, so no function may take a macro's name
 *    (`FUNCTION_NAME_RESERVED`); clearing keeps a call that did parse reported
 *    as the module call it names.
 *  - `async` must be set explicitly: cel-js derives it for an `rcall` from
 *    `receiverWithArgs`, which only the rcall's own checker fills in — and ours
 *    replaces it.
 *
 * The dispatch table is read from the activation under a key no CEL source can
 * spell, so nothing an author can write reaches the mechanism past the export
 * gate or the dependency edge. Binding the table is the kernel's, per scope;
 * until something binds one, evaluating a module call throws naming the
 * function.
 */
import type { ASTNode } from "@marcbachmann/cel-js";

/**
 * Activation key the per-scope dispatch table is read from.
 *
 * `@` and `:` are outside CEL's identifier grammar and there is no other way to
 * reach the activation, so no expression can name this — a spellable dispatcher
 * would let an author call past the export gate and past the dependency edge
 * that orders the callee before its caller.
 */
export const MODULE_CALL_DISPATCH_KEY = "@telo:module-functions";

/** Per-scope binding table: qualified name → the callable's `call`. */
export type ModuleCallDispatch = ReadonlyMap<string, (args: readonly unknown[]) => unknown>;

/**
 * The CEL type a qualified call yields, as a type name (`"string"`,
 * `"list<int>"`), or undefined for "not known here".
 *
 * A hook rather than a table because the answer belongs to the analysis, not to
 * the expression: a signature is declared on a resource in the module the call
 * resolves through. With no resolver — every compile, and every analysis until
 * signatures are typed — a module call is `dyn`, which types its arguments and
 * claims nothing about its result.
 */
export type ModuleCallTypeResolver = (qualified: string) => string | undefined;

/** cel-js internals this module drives. Structural, because the package's
 *  typings expose neither `meta` nor `setMeta`. */
interface MetaNode {
  readonly meta?: Record<string, unknown>;
  setMeta(key: string, value: unknown): MetaNode;
}

/** cel-js's `ASTNode` is a union over its operators, so it has no statically
 *  known members to extend — the internals are read through this cast, in one
 *  place. */
const metaOf = (node: ASTNode): MetaNode => node as unknown as MetaNode;

/** The macro record a resolved node carries. `teloModuleCall` is the brand every
 *  reader tests — cel-js puts its own macros under the same key. */
interface ModuleCallMacro {
  readonly teloModuleCall: true;
  readonly qualified: string;
  readonly args: readonly ASTNode[];
  /** Each argument's checked type name, recorded by the last type check. */
  argumentTypes?: readonly string[];
  typeCheck(chk: TypeCheckerLike, macro: ModuleCallMacro, ctx: unknown): unknown;
  evaluate(ev: EvaluatorLike, macro: ModuleCallMacro, ctx: ActivationLike): unknown;
}

interface TypeCheckerLike {
  readonly dynType: unknown;
  check(node: ASTNode, ctx: unknown): unknown;
  getType(name: string): unknown;
}

interface EvaluatorLike {
  eval(node: ASTNode, ctx: unknown): unknown;
}

interface ActivationLike {
  getValue(key: string): unknown;
}

/** What a resolved module call says about itself: the qualified name as
 *  written, the argument nodes, and — once the tree has been type-checked — the
 *  type the checker gave each argument. The single reader — no other surface
 *  pattern-matches the macro's shape. */
export interface ModuleCall {
  readonly qualified: string;
  readonly args: readonly ASTNode[];
  readonly argumentTypes?: readonly string[];
}

export function moduleCallOf(node: ASTNode): ModuleCall | undefined {
  const macro = metaOf(node).meta?.macro as ModuleCallMacro | undefined;
  return macro?.teloModuleCall === true
    ? {
        qualified: macro.qualified,
        args: macro.args,
        ...(macro.argumentTypes ? { argumentTypes: macro.argumentTypes } : {}),
      }
    : undefined;
}

/** Message for a call nothing has bound. Not a fallback value: a call that
 *  cannot reach its function has no result, and inventing one would make a
 *  missing export read as a null. */
export function unboundModuleCallMessage(qualified: string): string {
  const dot = qualified.indexOf(".");
  const receiver = qualified.slice(0, dot);
  const fn = qualified.slice(dot + 1);
  return (
    `unbound function '${qualified}' — nothing is bound under that name in this scope. ` +
    `'${receiver}' must be an imports: alias (or Self, or this module's own name) whose ` +
    `module declares a callable named '${fn}' and exports it.`
  );
}

const NO_NAMES: ReadonlySet<string> = new Set();

/**
 * Rewrite every module call in `ast` in place and report them in source order.
 *
 * Returns the qualified names as written (`["Billing.format", "Self.y"]`), which
 * is what a compiled value carries so no consumer has to re-parse to learn what
 * an expression calls. Idempotent: a node already resolved is rewritten once and
 * reported again, so two passes over one tree agree about what it calls.
 */
export function resolveModuleCalls(
  ast: ASTNode | undefined,
  moduleNames: ReadonlySet<string> = NO_NAMES,
  typeOf?: ModuleCallTypeResolver,
): string[] {
  const calls: string[] = [];
  if (ast && moduleNames.size > 0) visit(ast, moduleNames, typeOf, calls);
  return calls;
}

function visit(
  node: ASTNode,
  moduleNames: ReadonlySet<string>,
  typeOf: ModuleCallTypeResolver | undefined,
  calls: string[],
): void {
  // Already resolved: rewritten once, reported every time, so the return value
  // is what the TREE calls rather than what this pass happened to change.
  const resolved = moduleCallOf(node);
  if (resolved) {
    calls.push(resolved.qualified);
    for (const arg of resolved.args) visit(arg, moduleNames, typeOf, calls);
    return;
  }

  const receiver = moduleCallReceiver(node, moduleNames);
  if (receiver) {
    const [method, , args] = node.args as [string, ASTNode, ASTNode[]];
    const qualified = `${receiver}.${method}`;
    calls.push(qualified);
    rewrite(node, qualified, args, typeOf);
    // The receiver names a MODULE, not a value, so it is not descended into:
    // that is what keeps it out of every access chain, out of `refs`, and out
    // of the undeclared-root check.
    for (const arg of args) visit(arg, moduleNames, typeOf, calls);
    return;
  }
  descend(node, (child) => visit(child, moduleNames, typeOf, calls));
}

/** The module name a node's receiver is, or undefined when the node is not a
 *  module call. `a.b.c(x)` is not one — its receiver is a member access, not a
 *  bare identifier. */
function moduleCallReceiver(
  node: ASTNode,
  moduleNames: ReadonlySet<string>,
): string | undefined {
  if (node.op !== "rcall" || !Array.isArray(node.args)) return undefined;
  const [method, receiver, args] = node.args as [unknown, unknown, unknown];
  if (typeof method !== "string" || !Array.isArray(args)) return undefined;
  if (!isNode(receiver) || receiver.op !== "id") return undefined;
  const name = receiver.args as string;
  return moduleNames.has(name) ? name : undefined;
}

function rewrite(
  node: ASTNode,
  qualified: string,
  args: readonly ASTNode[],
  typeOf: ModuleCallTypeResolver | undefined,
): void {
  const macro: ModuleCallMacro = {
    teloModuleCall: true,
    qualified,
    args,
    typeCheck(chk, m, ctx) {
      // The arguments are checked in the CURRENT context, so a mistake inside
      // one is reported where it is written — and each argument's type is kept,
      // so whoever knows the callee's signature can compare against it.
      m.argumentTypes = m.args.map((arg) => typeNameOf(chk.check(arg, ctx)));
      // cel-js derives an rcall's asyncness from `receiverWithArgs`, which only
      // the rcall checker this macro replaces fills in — so it is stated: the
      // dispatch is synchronous, so the node is async exactly when one of its
      // arguments is. Asked only now, once each argument is checked: an
      // argument's answer is cached on first reading, and read before its own
      // check it is the conservative `true` for every operator and call.
      metaOf(node).setMeta(
        "async",
        m.args.some((arg) => (arg as { maybeAsync?: boolean }).maybeAsync === true),
      );
      const declared = typeOf?.(m.qualified);
      return declared === undefined ? chk.dynType : chk.getType(declared);
    },
    evaluate(ev, m, ctx) {
      const table = ctx.getValue(MODULE_CALL_DISPATCH_KEY) as ModuleCallDispatch | undefined;
      const fn = table?.get(m.qualified);
      if (!fn) throw new Error(unboundModuleCallMessage(m.qualified));
      const values = m.args.map((arg) => ev.eval(arg, ctx));
      // A callable's `call` is synchronous; an ARGUMENT need not be, and every
      // other dispatch in cel-js settles its operands first. Handing a pending
      // Promise to the function instead would pass it a value of the wrong type
      // with nothing reported.
      return values.some((value) => value instanceof Promise)
        ? Promise.all(values).then((settled) => fn(settled))
        : fn(values);
    },
  };
  metaOf(node)
    // A comprehension macro expands into an `alternate`, which cel-js consults
    // BEFORE `macro`. Left in place, `Billing.map(i, i)` would evaluate as a
    // comprehension over an identifier rather than as the module call it names.
    .setMeta("alternate", undefined)
    .setMeta("macro", macro);
}

/** Every resolved module call in `ast` with its node, outermost first. */
export function moduleCallNodes(ast: ASTNode | undefined): Array<{ node: ASTNode; call: ModuleCall }> {
  const out: Array<{ node: ASTNode; call: ModuleCall }> = [];
  if (ast) walk(ast);
  return out;

  function walk(node: ASTNode): void {
    const call = moduleCallOf(node);
    if (call) {
      out.push({ node, call });
      for (const arg of call.args) walk(arg);
      return;
    }
    descend(node, walk);
  }
}

/** The name of a checker type object (`int`, `list<string>`), or `dyn` for one
 *  that carries none. */
function typeNameOf(type: unknown): string {
  const name = (type as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" ? name : "dyn";
}

/**
 * Bare identifiers used as a call receiver that resolved to NO module name.
 *
 * `Foo.bar()` with no `Foo` import is an unknown identifier like any other, but
 * the repair is not the usual one — it needs an `imports:` alias, not a
 * different spelling — so the caller that reports the root says so.
 */
export function unresolvedCallReceivers(
  ast: ASTNode | undefined,
  moduleNames: ReadonlySet<string> = NO_NAMES,
): Set<string> {
  const out = new Set<string>();
  if (ast) walk(ast);
  return out;

  function walk(node: ASTNode): void {
    if (moduleCallOf(node)) {
      for (const arg of (node.args as [string, ASTNode, ASTNode[]])[2]) walk(arg);
      return;
    }
    if (node.op === "rcall" && Array.isArray(node.args)) {
      const receiver = (node.args as [unknown, unknown, unknown])[1];
      if (isNode(receiver) && receiver.op === "id" && !moduleNames.has(receiver.args as string)) {
        out.add(receiver.args as string);
      }
    }
    descend(node, walk);
  }
}

/**
 * Names bound INSIDE the expression — a comprehension variable, a `cel.bind`
 * name — that collide with one of the module's names.
 *
 * Such a binding is unreachable through a call: `Billing.f(x)` inside it
 * resolves to the module, never to the bound value. Reported as a reserved name
 * rather than silently shadowed, which is the rule every other name in CEL
 * scope already follows.
 */
export function moduleNameBindings(
  ast: ASTNode | undefined,
  moduleNames: ReadonlySet<string> = NO_NAMES,
): string[] {
  const out: string[] = [];
  if (ast && moduleNames.size > 0) walk(ast);
  return [...new Set(out)];

  function walk(node: ASTNode): void {
    const bound = boundNameOf(node);
    if (bound !== undefined && moduleNames.has(bound)) out.push(bound);
    descend(node, walk);
  }
}

/** The name a binding form introduces: `cel.bind(<name>, …)`'s first argument,
 *  or a comprehension macro's iteration variable. */
function boundNameOf(node: ASTNode): string | undefined {
  if (node.op !== "rcall" || !Array.isArray(node.args)) return undefined;
  if (moduleCallOf(node)) return undefined;
  const [method, receiver, args] = node.args as [unknown, unknown, unknown];
  if (!Array.isArray(args) || args.length === 0) return undefined;
  const first = args[0];
  if (!isNode(first) || first.op !== "id") return undefined;
  if (method === "bind") {
    return isNode(receiver) && receiver.op === "id" && receiver.args === "cel"
      ? (first.args as string)
      : undefined;
  }
  return COMPREHENSION_METHODS.has(method as string) ? (first.args as string) : undefined;
}

/** cel-js's comprehension macros, which bind their first argument as the
 *  iteration variable. Mirrors the set `analyze.ts` walks with. */
const COMPREHENSION_METHODS = new Set(["filter", "map", "exists", "all", "exists_one"]);

/** Generic descent over a node's operands — an array, a single node, or an
 *  array of arrays (a map literal's entries). */
function descend(node: ASTNode, fn: (child: ASTNode) => void): void {
  const args = node.args as unknown;
  if (Array.isArray(args)) {
    for (const arg of args) {
      if (isNode(arg)) fn(arg);
      else if (Array.isArray(arg)) for (const item of arg) if (isNode(item)) fn(item);
    }
    return;
  }
  if (isNode(args)) fn(args);
}

function isNode(v: unknown): v is ASTNode {
  return v !== null && typeof v === "object" && "op" in (v as Record<string, unknown>);
}
