/**
 * Which dereferences a guard has proven safe.
 *
 * A value whose declared type admits null is only safely dereferenced where something
 * has proven it is not null, and **what counts as proof is exactly three constructs**:
 * a ternary, `&&` and `||`. Not more, not less. That bound is not a simplification — a
 * consumer switching engines must not newly accept an expression (which recognising
 * another construct would do) nor newly reject one (which recognising fewer would do),
 * and a guard written as a function call is deliberately not proof.
 *
 * The rules, over a condition `c`:
 *
 * - `chain != null` proves `chain` where `c` holds; `chain == null` proves it where `c`
 *   fails. `null` may stand on either side of the comparison.
 * - `!c` swaps the two.
 * - `a && b` proves, where it holds, everything `a` and `b` prove; where it fails,
 *   nothing, since either arm may be the one that failed.
 * - `a || b` is the mirror: where it fails, both arms failed, so both their negative
 *   proofs hold.
 *
 * A chain is a plain path of named members (`error.code`), which is what a proof can
 * name: nothing proves anything about `xs[i].code`, because the index is not part of a
 * name.
 */

import type { CelNode } from "./syntax-tree.js";

/** The dotted path a node spells, if it is a plain chain of named members. */
export function chainText(node: CelNode): string | undefined {
  if (node.kind === "ident") return node.name;
  if (node.kind !== "select" || node.optional || node.field === "") return undefined;
  const operand = chainText(node.operand);
  return operand === undefined ? undefined : `${operand}.${node.field}`;
}

/**
 * The name a chain is rooted at, or nothing when it is not a chain of plain members over a
 * name. It is what says whether the chain's subject is a name the EXPRESSION bound — a
 * comprehension variable, a `cel.bind` name — rather than one the host declared.
 */
export function chainRoot(node: CelNode): string | undefined {
  if (node.kind === "ident") return node.name;
  if (node.kind !== "select" || node.optional || node.field === "") return undefined;
  return chainRoot(node.operand);
}

/** The chains proven non-null where the condition holds. */
export function provenWhereTrue(condition: CelNode): readonly string[] {
  switch (condition.kind) {
    case "binary":
      if (condition.operator === "!=") return nullTest(condition);
      if (condition.operator === "&&") {
        return [...provenWhereTrue(condition.left), ...provenWhereTrue(condition.right)];
      }
      return [];
    case "unary":
      return condition.operator === "!" ? provenWhereFalse(condition.operand) : [];
    default:
      return [];
  }
}

/** The chains proven non-null where the condition fails. */
export function provenWhereFalse(condition: CelNode): readonly string[] {
  switch (condition.kind) {
    case "binary":
      if (condition.operator === "==") return nullTest(condition);
      if (condition.operator === "||") {
        return [...provenWhereFalse(condition.left), ...provenWhereFalse(condition.right)];
      }
      return [];
    case "unary":
      return condition.operator === "!" ? provenWhereTrue(condition.operand) : [];
    default:
      return [];
  }
}

/** The chain a comparison against `null` is about, either way round. */
function nullTest(comparison: Extract<CelNode, { kind: "binary" }>): readonly string[] {
  const { left, right } = comparison;
  if (isNullLiteral(right)) {
    const chain = chainText(left);
    return chain === undefined ? [] : [chain];
  }
  if (isNullLiteral(left)) {
    const chain = chainText(right);
    return chain === undefined ? [] : [chain];
  }
  return [];
}

function isNullLiteral(node: CelNode): boolean {
  return node.kind === "literal" && node.literal.type === "null";
}
