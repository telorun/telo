/**
 * Whether each macro call is shaped like one at all, judged before any type is read.
 *
 * A macro's own arguments are not values: `xs.map(i, …)` declares the name `i`, and
 * `has(a.b)` asks about the member `b` of a chain of names. Neither is something a type
 * can be wrong about — they are either written in the shape the macro takes, or the call
 * is not that macro. So this is a **structural** pass over the whole tree, and it runs
 * first: a macro written wrongly is reported before anything inside it is typed, because
 * the typing of its body depends on a name the call failed to declare.
 *
 * The walk is **post-order**, so the innermost mistake is the one reported first. Nesting
 * macros is how a generated expression goes wrong, and the inner call is the one a reader
 * has to fix.
 */

import type { CelCheckCode } from "./check-diagnostic.js";
import { namespaceMacroBinding, receiverMacroBinding } from "./comprehension-bindings.js";
import type { CelNode, SourceRange } from "./syntax-tree.js";
import { childNodes } from "./syntax-tree.js";

export interface MacroShapeFinding {
  readonly code: CelCheckCode;
  readonly message: string;
  readonly range: SourceRange;
}

/** Every macro call whose own arguments are not the shape it takes, innermost first. */
export function macroShapeFindings(root: CelNode): readonly MacroShapeFinding[] {
  const findings: MacroShapeFinding[] = [];
  collect(root, findings);
  return findings;
}

function collect(node: CelNode, findings: MacroShapeFinding[]): void {
  for (const child of childNodes(node)) collect(child, findings);
  const finding = shapeOf(node);
  if (finding) findings.push(finding);
}

function shapeOf(node: CelNode): MacroShapeFinding | undefined {
  if (node.kind === "call" && node.name === "has" && node.args.length === 1) {
    const argument = node.args[0]!;
    if (argument.kind === "select" && argument.field !== "") return undefined;
    return {
      code: "CEL_INVALID_ARGUMENT",
      message: "has() asks whether a member is there, so it takes a member read: write has(a.b)",
      range: argument.range,
    };
  }
  if (node.kind !== "receiverCall") return undefined;
  const binding =
    receiverMacroBinding(node.name, node.args.length) ??
    namespaceMacroBinding(
      node.receiver.kind === "ident" ? node.receiver.name : "",
      node.name,
      node.args.length,
    );
  if (!binding) return undefined;
  const variable = node.args[binding.variableArgument]!;
  if (variable.kind === "ident") return undefined;
  return {
    code: "CEL_INVALID_ARGUMENT",
    message: `${node.name} binds a name here, and this is not a name`,
    range: variable.range,
  };
}
