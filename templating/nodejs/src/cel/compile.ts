/**
 * Compiling one CEL expression into a `CompiledValue`, and the repeatability verdict on its
 * text.
 *
 * **The module-call rewrite is gone from this package.** It used to happen here, on the
 * parsed tree, through internals the previous engine did not expose — a `setMeta('macro')`
 * redirect that made a qualified call check and evaluate as something else. `@telorun/cel`
 * has `qcall` as a node of its own, produced by a total tree-to-tree pass over the name set
 * (`parseExpression({ namespaces })`), and a `CelExpression` records the set it was resolved
 * under, so an environment refuses a tree resolved for a different site rather than
 * silently answering a different question. What is left here is reading the result.
 */
import { hostValueOf, type CompiledValue } from "@telorun/sdk";
import {
  functionCatalog,
  qualifiedCalls,
  rootReferences,
  walkTree,
  type CelEnvironment,
  type CelExpression,
  type CelNode,
  type NamespaceImplementation,
} from "@telorun/cel";
import {
  celNamespaceNames,
  MODULE_CALL_DISPATCH_KEY,
  type ModuleCallDispatch,
} from "./module-call.js";

const NO_NAMESPACES: ReadonlySet<string> = new Set();

/** Catalog functions whose result differs per call, by name. */
const NON_DETERMINISTIC = new Set(
  functionCatalog()
    .filter((entry) => !entry.deterministic)
    .map((entry) => entry.name),
);

/**
 * True when the expression calls a catalog function whose result differs per call
 * (`uuidv4()`, `nowMillis()`), so evaluating it once and reusing the value would change
 * what it means.
 */
function callsNonDeterministic(root: CelNode): boolean {
  for (const node of walkTree(root)) {
    if ((node.kind === "call" || node.kind === "receiverCall") && NON_DETERMINISTIC.has(node.name)) {
      return true;
    }
  }
  return false;
}

/**
 * True when the expression calls a method on a bare identifier (`Billing.f(x)`). Whether
 * that identifier names a module is the declaring module's to say, and the text alone does
 * not, so every such call may be a module call.
 *
 * A call the name set DID resolve is a `qcall` and is not this: it is already known to be a
 * module's, and its determinism is its callee's.
 */
function callsOnBareReceiver(root: CelNode): boolean {
  for (const node of walkTree(root)) {
    if (node.kind === "receiverCall" && node.receiver.kind === "ident") return true;
  }
  return false;
}

/**
 * Whether an expression's text, written twice in one value, means one value both times: it
 * calls no catalog function whose result differs per call, and makes no call that may be a
 * module's — a module function's determinism is its callee's, which the text does not say.
 *
 * Text that does not read whole means no value, so it is not repeatable; `analyze` is what
 * reports why. Reading never throws here, which is the engine's own contract: the first
 * unreadable thing is one ranged diagnostic and the tree keeps the longest prefix.
 */
export function repeatableExpression(expr: string, environment: CelEnvironment): boolean {
  const parsed = environment.parse(expr);
  if (parsed.diagnostics.length > 0) return false;
  return !callsNonDeterministic(parsed.root) && !callsOnBareReceiver(parsed.root);
}

/**
 * Compile one CEL expression into a `CompiledValue`. The `!cel` engine compiles its whole
 * scalar with it, and the tags with holes compile each hole.
 *
 * `moduleNames` are the declaring module's own names; a call whose receiver is one of them
 * is resolved to a `qcall` as the expression is READ, so every later reader — the root
 * references below, the analyzer's passes, the kernel's dependency walk — sees the resolved
 * shape rather than re-deriving it from the source text.
 */
export function compileExpression(
  expr: string,
  environment: CelEnvironment,
  moduleNames?: ReadonlySet<string>,
): CompiledValue {
  // Only the names CEL can read as a namespace: a set holding `my-module` is refused WHOLE
  // at registration, and a name that cannot be one resolves no call anyway.
  const namespaces = moduleNames === undefined ? NO_NAMESPACES : celNamespaceNames(moduleNames);
  if (namespaces.size === 0) {
    return compiledValueOf(expr, environment.parse(expr), environment);
  }
  // A clone carrying the site's names: the tree is resolved under them, and the environment
  // that compiles it must declare the same set or it refuses the tree.
  const site = environment.clone();
  for (const name of namespaces) site.registerNamespace(name);
  return compiledValueOf(expr, site.parse(expr), site);
}

/** A `CompiledValue` over an expression already read against its site's names. */
export function compiledValueOf(
  expr: string,
  parsed: CelExpression,
  environment: CelEnvironment,
): CompiledValue {
  const program = environment.compile(parsed);
  // As written — `CompiledValue.calls` is the qualified spellings, not their shapes.
  const calls = qualifiedCalls(parsed.root).map((call) => call.qualifiedName);
  return {
    __compiled: true,
    source: expr,
    refs: rootReferences(parsed.root),
    calls,
    ...(callsNonDeterministic(parsed.root) ? { volatile: true as const } : {}),
    // **A module call is dispatched through the engine's namespace seam**, reading the table
    // the owning scope bound on the activation. Evaluating without it reaches no function at
    // all: the engine would answer its own `unbound_function` for every qualified call,
    // whatever the kernel bound, so the whole dispatch is silently dead.
    call: (ctx: Record<string, unknown>) =>
      hostValueOf(program.evaluate(ctx as never, { namespaceFunction: dispatchFrom(ctx) })),
  };
}

/**
 * How a qualified call reaches its function: the per-scope table the kernel binds on the
 * activation under a key outside CEL's identifier grammar, so no author can call past the
 * export gate or the dependency edge.
 *
 * **A name nothing bound answers `undefined`, and that ordering is load-bearing.** The engine
 * looks a qualified call's function up BEFORE it evaluates the arguments, so returning
 * `undefined` refuses the call where it is written and nothing inside it runs. Answering a
 * stub that throws instead makes the lookup succeed: the arguments are evaluated first, so
 * `Billing.missing(Billing.total(1))` DISPATCHES `Billing.total` — observable work, possibly
 * host-backed — for a call that was never going to reach a function. The vectors pin exactly
 * that (`dispatched: []`), and the repair advice belongs to the static verdict the analyzer
 * reports at the call, which is where an author reads it, not to a runtime message.
 *
 * **A module function's arguments are a host boundary, so they cross through the one seam**
 * (`hostValueOf`). What is behind a qualified call is a `Telo.Callable` — a CEL body whose
 * parameters are AJV-checked against its declared `params`, or a controller's own `call` —
 * and neither reads a `CelMap`: a map literal written at a call site arrived as
 * `{"entries":{}}` and was refused for a property its author had written.
 */
function dispatchFrom(
  activation: Record<string, unknown>,
): (namespace: string, name: string) => NamespaceImplementation | undefined {
  // With no table bound, every qualified call answers `undefined` — the engine's
  // own `unbound_function`, refused before its arguments are evaluated.
  return (
    namespaceDispatchOf(activation[MODULE_CALL_DISPATCH_KEY] as ModuleCallDispatch | undefined) ??
    (() => undefined)
  );
}

/**
 * A scope's module functions as the engine's own per-evaluation dispatch — **the one
 * adapter**, so every host that binds a table converts its arguments the same way.
 *
 * The table is keyed by qualified name (`Billing.total`), the form the kernel and the
 * analyzer both hold it in; the engine asks by namespace and name, never learning that a
 * qualified name is one string with a dot in it. A second adapter is what made `telo check`
 * and the kernel disagree: the analyzer kept its own, called the bound function with the raw
 * values, and handed a map literal written at a call site a `CelMap` where the kernel handed
 * a plain object — a check/run divergence by construction, in the one direction nothing
 * reports.
 */
export function namespaceDispatchOf(
  table: ModuleCallDispatch | undefined,
): ((namespace: string, name: string) => NamespaceImplementation | undefined) | undefined {
  if (!table) return undefined;
  return (namespace, name) => {
    const bound = table.get(`${namespace}.${name}`);
    return bound ? (args) => bound(args.map(hostValueOf)) as never : undefined;
  };
}
