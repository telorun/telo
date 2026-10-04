/**
 * Module calls: what a resolved one says, where the dispatch table hangs, and the two walks
 * the analyzer asks of an expression's own names.
 *
 * **The rewrite is gone.** `Alias.fn(x)` and `obj.method(x)` are the same syntax and only a
 * set of names distinguishes them, so this package used to rewrite the parsed tree itself,
 * through internals the previous engine did not expose: a `setMeta('macro', …)` redirect
 * that made a qualified call check and evaluate as something else, with a comprehension
 * macro's `alternate` winning over `macro` unless cleared, and an rcall's asyncness derived
 * from state the replaced checker filled in. Three facts about a dependency's internals,
 * each pinned by a test, and the reason it was pinned to an exact version.
 *
 * `@telorun/cel` has **`qcall` as a node of its own**, produced by a total tree-to-tree pass
 * over the name set — never by the parser, because the set is the host's — and a
 * `CelExpression` records the set it was resolved under, so an environment refuses a tree
 * resolved for a different site instead of answering a different question about it. So
 * reading a module call is reading a node kind, and there is nothing to rewrite and nothing
 * to pin.
 *
 * What is left here is Telo's half: the activation key the kernel binds a scope's table
 * under, the unbound message, and the two questions the analyzer asks about a module's own
 * names colliding with the expression's.
 */
import {
  childNodes,
  isIdentifierSpelling,
  isReservedWord,
  namespaceMacroBinding,
  qualifiedCalls,
  receiverMacroBinding,
  RESERVED_NAMESPACES,
  type CelNode,
} from "@telorun/cel";

/**
 * Where a scope's dispatch table hangs on the activation.
 *
 * `@` and `:` are outside CEL's identifier grammar and the activation is reachable no other
 * way, so no author can call past the export gate or the dependency edge. Binding the table
 * is the kernel's, per owning scope; with none, evaluating a module call is refused.
 */
export const MODULE_CALL_DISPATCH_KEY = "@telo:module-functions";

/** A scope's module functions, keyed by qualified name. */
export type ModuleCallDispatch = ReadonlyMap<string, (args: readonly unknown[]) => unknown>;

/**
 * What the host says a module call's RESULT is, as a CEL type expression. The engine types
 * the call node from it, so an operator over the call checks; absent, the call is `dyn`.
 */
export type ModuleCallTypeResolver = (qualified: string) => string | undefined;

/** What a resolved module call says about itself. */
export interface ModuleCall {
  readonly qualified: string;
  readonly args: readonly CelNode[];
}

/** The module call this node IS, or nothing. One node kind, no pattern-matching. */
export function moduleCallOf(node: CelNode): ModuleCall | undefined {
  if (node.kind !== "qcall") return undefined;
  return { qualified: `${node.namespace}.${node.name}`, args: node.args };
}

/**
 * Message for a call nothing has bound. Not a fallback value: a call that cannot reach its
 * function has no result, and inventing one would make a missing export read as a null.
 */
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

/**
 * Which of a module's own names CEL can read as a namespace.
 *
 * **A module name and an import alias are YAML scalars nothing lexes where they are
 * written** — `my-module`, `test-run` and `cel` all reach a name set, and the naming
 * diagnostics (`INVALID_NAME`, `INVALID_TYPE_NAME`) are what report them. The engine refuses
 * such a name at registration and refuses the SET WHOLE, so handing one over unfiltered
 * turns a reportable name into a crash that loses every other diagnostic in the file. A name
 * CEL cannot read as a namespace resolves no call, which is exactly what the naming
 * diagnostic says is wrong with it.
 *
 * It is here rather than in a consumer because the module-name set is this package's concept
 * — `CompileEnv.moduleNames` — and three callers need the same answer: compiling an
 * expression, the analyzer's typed site environments, and the kernel's type-rule conditions.
 */
export function celNamespaceNames(moduleNames: Iterable<string>): ReadonlySet<string> {
  const usable = new Set<string>();
  for (const name of moduleNames) {
    if (!isIdentifierSpelling(name) || isReservedWord(name)) continue;
    if (RESERVED_NAMESPACES.includes(name)) continue;
    usable.add(name);
  }
  return usable;
}

const NO_NAMES: ReadonlySet<string> = new Set();

/** Every resolved module call in the tree with its node, outermost first. */
export function moduleCallNodes(
  root: CelNode | undefined,
): Array<{ node: CelNode; call: ModuleCall }> {
  const out: Array<{ node: CelNode; call: ModuleCall }> = [];
  if (root) walk(root);
  return out;

  function walk(node: CelNode): void {
    const call = moduleCallOf(node);
    if (call) out.push({ node, call });
    for (const child of childNodes(node)) walk(child);
  }
}

/** Every qualified call's name, as written. */
export function moduleCallNames(root: CelNode | undefined): readonly string[] {
  return root ? qualifiedCalls(root).map((call) => call.qualifiedName) : [];
}

/**
 * Bare identifiers that are the RECEIVER of an unresolved call (`dbb.query(1)`), so the
 * caller reporting the root can ask whether such a name could denote a module at all rather
 * than telling an author to add an `imports:` alias for a typo.
 *
 * A call the name set resolved is a `qcall` and is not here — it names a module, so reading
 * its receiver as a root would invent a dependency the expression never states.
 */
export function unresolvedCallReceivers(
  root: CelNode | undefined,
  moduleNames: ReadonlySet<string> = NO_NAMES,
): Set<string> {
  const out = new Set<string>();
  if (root) walk(root);
  return out;

  function walk(node: CelNode): void {
    if (
      node.kind === "receiverCall" &&
      node.receiver.kind === "ident" &&
      !moduleNames.has(node.receiver.name)
    ) {
      out.add(node.receiver.name);
    }
    for (const child of childNodes(node)) walk(child);
  }
}

/**
 * Names bound INSIDE the expression — a comprehension variable, a `cel.bind` name — that
 * collide with one of the module's names.
 *
 * Such a binding is unreachable through a call: `Billing.f(x)` inside it resolves to the
 * module, never to the bound value. Reported as a reserved name rather than silently
 * shadowed, which is the rule every other name in CEL scope already follows.
 *
 * The binding forms come from the engine's own enumeration (`BINDING_FORMS`) rather than a
 * list kept in step with it here — the previous spelling carried a hand-written set of
 * comprehension method names, mirrored in a second file.
 */
export function moduleNameBindings(
  root: CelNode | undefined,
  moduleNames: ReadonlySet<string> = NO_NAMES,
): string[] {
  const out: string[] = [];
  if (root && moduleNames.size > 0) walk(root);
  return [...new Set(out)];

  function walk(node: CelNode): void {
    const bound = boundNameOf(node);
    if (bound !== undefined && moduleNames.has(bound)) out.push(bound);
    for (const child of childNodes(node)) walk(child);
  }
}

/**
 * The name a binding form introduces: a comprehension macro's iteration variable, or
 * `cel.bind(<name>, …)`'s first argument.
 *
 * **The binding is asked of the engine by NAME AND ARITY.** `BINDING_FORMS` is a list of
 * `"map/2"`, `"map/3"`, `"cel.bind/3"` — a bare `"map"` matches none of them, so a set over
 * the list and a `.has(node.name)` test silently never fires.
 *
 * **And `cel` is a RESERVED namespace** (`cel`, `optional`), which a host can never claim —
 * so `cel.bind(c, …)` is not a qualified call at all: it reads as a receiver call on the
 * ident `cel`, which is in no scope and never will be. Reading it as a `qcall` matches
 * nothing, and the cost is not just a missed binding: the bound name and the bare `cel` then
 * leak out as member-access chains, so a comprehension variable is reported as an undeclared
 * field and `cel` itself as an unknown identifier.
 */
function boundNameOf(node: CelNode): string | undefined {
  if (node.kind !== "receiverCall") return undefined;
  const binding =
    node.receiver.kind === "ident" && node.receiver.name === "cel"
      ? namespaceMacroBinding("cel", node.name, node.args.length)
      : receiverMacroBinding(node.name, node.args.length);
  if (!binding) return undefined;
  const held = node.args[binding.variableArgument];
  return held?.kind === "ident" ? held.name : undefined;
}
