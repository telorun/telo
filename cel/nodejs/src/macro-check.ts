/**
 * Typing the macros — the constructs that are written as calls and are not functions.
 *
 * A macro binds a name, or inspects the shape of its argument, so it cannot be a
 * registered signature: `xs.map(i, i + 1)` has no argument type for `i`, and `has(a.b)`
 * is about whether `b` is there rather than about its value. The parser deliberately
 * leaves each one an ordinary call node (expanding it would make the source unwritable
 * from the tree), so this is where the comprehension appears — in the checker's own
 * lowering, which is also why a macro is **not** a dispatched call in the call listing.
 *
 * Which arguments a macro binds a name over is declared once, in
 * `comprehension-bindings.ts`, and read both here and by the free-variable query. Two
 * tables would be two answers to "what does this macro bind".
 */

import type { CelType } from "./cel-type.js";
import { BOOL, DYN, formatType, isDyn, listOf, optionalOf, parameterOf } from "./cel-type.js";
import type { CelCheckCode } from "./check-diagnostic.js";
import { namespaceMacroBinding, receiverMacroBinding } from "./comprehension-bindings.js";
import type { CelNode, SourceRange } from "./syntax-tree.js";

/** What a macro needs of the checker around it. */
export interface MacroHost {
  /** The type of a subexpression, in the scope that holds here. */
  typeOf(node: CelNode): CelType;
  /** The type of a subexpression with extra names in scope. */
  typeOfBinding(node: CelNode, bindings: ReadonlyMap<string, CelType>): CelType;
  /**
   * The type of a select read as a question about PRESENCE — `has()`'s argument. It is
   * the same reading `.?b` gets, which is what keeps the two forms of one question from
   * answering differently about a union whose branches do not all hold the member.
   */
  typeOfPresence(node: Extract<CelNode, { kind: "select" }>): CelType;
  report(code: CelCheckCode, message: string, range: SourceRange): void;
}

/** The reserved namespaces a macro is written on, and the macros on each. */
const NAMESPACE_MACROS: Readonly<Record<string, readonly string[]>> = {
  cel: ["bind"],
  optional: ["of", "none", "ofNonZeroValue"],
};

/** The optional library's two name-binding members, which no signature can state. */
const OPTIONAL_BINDING_MACROS = new Set(["optMap", "optFlatMap"]);

/** Whether a call is a macro at all — asked before any overload is looked for. */
export function isMacroCall(node: CelNode): boolean {
  if (node.kind === "call") return node.name === "has" && node.args.length === 1;
  if (node.kind !== "receiverCall") return false;
  if (receiverMacroBinding(node.name, node.args.length)) return true;
  const receiver = node.receiver;
  if (receiver.kind !== "ident") return false;
  const on = NAMESPACE_MACROS[receiver.name];
  return on !== undefined && on.includes(node.name);
}

/**
 * The type of a macro call. `isMacroCall` has already said it is one; anything this
 * cannot type reports its own diagnostic and answers `dyn`, so one mistake stays one.
 */
export function checkMacro(node: CelNode, host: MacroHost): CelType {
  if (node.kind === "call") return checkHas(node, host);
  if (node.kind !== "receiverCall") return DYN;
  const receiver = node.receiver;
  if (receiver.kind === "ident" && NAMESPACE_MACROS[receiver.name]) {
    return receiver.name === "cel"
      ? checkBind(node, host)
      : checkOptionalNamespace(node, host);
  }
  if (OPTIONAL_BINDING_MACROS.has(node.name) && node.args.length === 2) {
    return checkOptionalBinding(node, host);
  }
  return checkComprehension(node, host);
}

/**
 * `opt.optMap(v, expr)` and `opt.optFlatMap(v, expr)`: the held value under a name, for
 * one expression. `optMap` wraps what that expression answers; `optFlatMap` takes an
 * optional from it and does not wrap it again.
 */
function checkOptionalBinding(node: Extract<CelNode, { kind: "receiverCall" }>, host: MacroHost): CelType {
  const receiver = host.typeOf(node.receiver);
  const name = node.args[0]!;
  if (name.kind !== "ident") return DYN;
  let held: CelType = DYN;
  if (receiver.kind === "optional") held = receiver.value;
  else if (!isDyn(receiver) && receiver.kind !== "parameter") {
    host.report(
      "CEL_TYPE_ERROR",
      `${node.name} reads an optional, and ${formatType(receiver)} is not one`,
      node.receiver.range,
    );
  }
  const result = host.typeOfBinding(node.args[1]!, new Map([[name.name, held]]));
  if (node.name === "optMap") return optionalOf(result);
  if (result.kind === "optional" || isDyn(result) || result.kind === "parameter") return result;
  host.report(
    "CEL_TYPE_ERROR",
    `optFlatMap's expression must answer an optional, and it answers ${formatType(result)}`,
    node.args[1]!.range,
  );
  return optionalOf(DYN);
}

/** `has(a.b)` — a question about presence. Its shape is already validated. */
function checkHas(node: Extract<CelNode, { kind: "call" }>, host: MacroHost): CelType {
  const argument = node.args[0]!;
  if (argument.kind === "select") host.typeOfPresence(argument);
  return BOOL;
}

/** `cel.bind(name, value, body)` — a name for one value, in scope in the body alone. */
function checkBind(node: Extract<CelNode, { kind: "receiverCall" }>, host: MacroHost): CelType {
  const binding = namespaceMacroBinding("cel", node.name, node.args.length);
  if (!binding) {
    host.report(
      "CEL_INVALID_ARGUMENT",
      "cel.bind(name, value, body) takes three arguments: a name, its value, and the expression that reads it",
      node.range,
    );
    return DYN;
  }
  const name = node.args[binding.variableArgument]!;
  if (name.kind !== "ident") return DYN;
  const value = host.typeOf(node.args[1]!);
  return host.typeOfBinding(node.args[2]!, new Map([[name.name, value]]));
}

/** `optional.of(v)`, `optional.ofNonZeroValue(v)` and `optional.none()`. */
function checkOptionalNamespace(node: Extract<CelNode, { kind: "receiverCall" }>, host: MacroHost): CelType {
  if (node.name === "none") {
    if (node.args.length !== 0) {
      host.report("CEL_INVALID_ARGUMENT", "optional.none() takes no argument", node.range);
    }
    return optionalOf(parameterOf("T"));
  }
  if (node.args.length !== 1) {
    host.report("CEL_INVALID_ARGUMENT", `optional.${node.name}(value) takes one argument`, node.range);
    return optionalOf(DYN);
  }
  return optionalOf(host.typeOf(node.args[0]!));
}

/** `all`, `exists`, `exists_one`, `filter` and `map` over a list or a map. */
function checkComprehension(node: Extract<CelNode, { kind: "receiverCall" }>, host: MacroHost): CelType {
  const binding = receiverMacroBinding(node.name, node.args.length)!;
  const receiver = host.typeOf(node.receiver);
  const element = iterationType(receiver, node, host);
  const name = node.args[binding.variableArgument]!;
  if (name.kind !== "ident") return DYN;
  const bindings = new Map([[name.name, element]]);
  const scoped = binding.scopedArguments.map((at) => ({
    node: node.args[at]!,
    type: host.typeOfBinding(node.args[at]!, bindings),
  }));

  if (node.name === "all" || node.name === "exists" || node.name === "exists_one") {
    requireBool(scoped[0]!, node.name, host);
    return BOOL;
  }
  if (node.name === "filter") {
    requireBool(scoped[0]!, node.name, host);
    return listOf(element);
  }
  // `map` in both arities: the last scoped argument is the transform, and a third
  // argument makes the one before it a filter.
  if (scoped.length === 2) requireBool(scoped[0]!, node.name, host);
  return listOf(scoped.at(-1)!.type);
}

function requireBool(
  scoped: { node: CelNode; type: CelType },
  name: string,
  host: MacroHost,
): void {
  if (isDyn(scoped.type) || scoped.type.kind === "parameter") return;
  if (scoped.type.kind === "primitive" && scoped.type.name === "bool") return;
  host.report(
    "CEL_TYPE_ERROR",
    `${name}'s test must be bool, and it is ${formatType(scoped.type)}`,
    scoped.node.range,
  );
}

/** What one element of a comprehension's receiver is: a list's element, a map's key. */
function iterationType(receiver: CelType, node: CelNode, host: MacroHost): CelType {
  if (isDyn(receiver) || receiver.kind === "parameter") return DYN;
  if (receiver.kind === "list") return receiver.element;
  if (receiver.kind === "map") return receiver.key;
  if (receiver.kind === "record") return { kind: "primitive", name: "string" };
  host.report(
    "CEL_TYPE_ERROR",
    `a comprehension reads a list or a map, and ${formatType(receiver)} is neither`,
    node.kind === "receiverCall" ? node.receiver.range : node.range,
  );
  return DYN;
}
