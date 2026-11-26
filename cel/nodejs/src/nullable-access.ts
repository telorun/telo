/**
 * What a guard proves about the chains it names.
 *
 * A value whose declared type admits null is only safely dereferenced where something
 * has proven it is not null, and **what counts as proof is three constructs**: a
 * ternary, `&&` and `||`, over three kinds of test — a comparison of a chain against
 * `null`, `has(chain.member)`, and a type test `type(chain) == T`. A guard written as any
 * other call is not proof.
 *
 * The rules, over a condition `c`:
 *
 * - `chain != null` proves `chain` non-null where `c` holds; `chain == null` proves it
 *   where `c` fails. `null` may stand on either side of the comparison.
 * - `has(chain.m)` proves, where it holds, that `chain` holds `m`: it is narrowed to the
 *   shapes that can hold that member.
 * - `type(chain) == T` (or `T == type(chain)`) proves, where it holds, that `chain` is one
 *   of the members whose runtime type is `T`, and where it fails one of the others; `!=`
 *   swaps them. Whether `T` names a type, and which, is the checker's to decide: it is
 *   known only once the comparison is typed.
 * - `chain.m == lit` (either order) and `chain.m in [lit, …]`, every element a literal, prove
 *   where they hold that `chain` is of the members whose `m` can equal a listed literal, and
 *   where they fail of those whose `m` can hold a value outside them; `!=` swaps them. Where
 *   the test holds the compared chain itself is of the members whose type a listed literal
 *   can have (`x == 'a'`), unless null is listed. `m` is read by a literal name, `.m` or `['m']`; a literal is a
 *   string, int, uint, double, bool or null literal, a negated number included.
 * - `!c` swaps the two.
 * - `a && b` proves, where it holds, everything `a` and `b` prove; where it fails,
 *   nothing, since either arm may be the one that failed.
 * - `a || b` is the mirror: where it fails, both arms failed, so both their negative
 *   proofs hold.
 *
 * A chain is a plain path of named members over a name (`error.code`), which is what a
 * proof can name: nothing proves anything about `xs[i].code`, because the index is not
 * part of a name. A proof is about the name its chain is rooted at, so it does not hold
 * where a macro or `cel.bind` binds that name again — unless the root is absolute (`.x.a`),
 * which names the declaration wherever it is read.
 */

import { literalValue as celLiteralValue, type CelValue } from "./cel-value.js";
import type { CelNode } from "./syntax-tree.js";

/**
 * The dotted path a node spells, if it is a plain chain of named members. An absolute root is
 * spelled with its dot (`.x.a`): it names the declaration, never a name the expression bound.
 */
export function chainText(node: CelNode): string | undefined {
  if (node.kind === "ident") return node.absolute ? `.${node.name}` : node.name;
  if (node.kind !== "select" || node.optional || node.field === "") return undefined;
  const operand = chainText(node.operand);
  return operand === undefined ? undefined : `${operand}.${node.field}`;
}

/**
 * What a guard proves about one chain: that it is not null, that it holds `member`, or that
 * the type test `typeTest.comparison` came out `holds`.
 */
export interface Proof {
  readonly chain: string;
  readonly member?: string;
  readonly typeTest?: { readonly comparison: CelNode; readonly holds: boolean };
  /**
   * An equality or membership test: the chain's member `member` — or, with none, the chain
   * itself — equals one of `values` (`holds`) or none of them.
   */
  readonly equals?: EqualityProof;
}

export interface EqualityProof {
  readonly member?: string;
  readonly values: readonly CelValue[];
  readonly holds: boolean;
}

/** The name a chain's text is rooted at, or `undefined` for an absolute chain, which no binding names. */
export function chainTextRoot(chain: string): string | undefined {
  if (chain.startsWith(".")) return undefined;
  const dot = chain.indexOf(".");
  return dot < 0 ? chain : chain.slice(0, dot);
}

/** What the condition proves where it holds. */
export function provenWhereTrue(condition: CelNode): readonly Proof[] {
  switch (condition.kind) {
    case "binary":
      if (condition.operator === "!=") {
        return [...nullTest(condition), ...typeTest(condition, false), ...equalityTest(condition, false)];
      }
      if (condition.operator === "==") return [...typeTest(condition, true), ...equalityTest(condition, true)];
      if (condition.operator === "in") return membershipTest(condition, true);
      if (condition.operator === "&&") {
        return [...provenWhereTrue(condition.left), ...provenWhereTrue(condition.right)];
      }
      return [];
    case "unary":
      return condition.operator === "!" ? provenWhereFalse(condition.operand) : [];
    case "call":
      return memberTest(condition);
    default:
      return [];
  }
}

/** What the condition proves where it fails. */
export function provenWhereFalse(condition: CelNode): readonly Proof[] {
  switch (condition.kind) {
    case "binary":
      if (condition.operator === "==") {
        return [...nullTest(condition), ...typeTest(condition, false), ...equalityTest(condition, false)];
      }
      if (condition.operator === "!=") return [...typeTest(condition, true), ...equalityTest(condition, true)];
      if (condition.operator === "in") return membershipTest(condition, false);
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
function nullTest(comparison: Extract<CelNode, { kind: "binary" }>): readonly Proof[] {
  const { left, right } = comparison;
  const tested = isNullLiteral(right) ? left : isNullLiteral(left) ? right : undefined;
  const chain = tested === undefined ? undefined : chainText(tested);
  return chain === undefined ? [] : [{ chain }];
}

/** The chains a comparison tests the type of, `type(chain)` on either side, left first. */
function typeTest(comparison: Extract<CelNode, { kind: "binary" }>, holds: boolean): readonly Proof[] {
  const proofs: Proof[] = [];
  for (const side of [comparison.left, comparison.right]) {
    const chain = typeTestedChain(side);
    if (chain !== undefined) proofs.push({ chain, typeTest: { comparison, holds } });
  }
  return proofs;
}

/** The chain `type(chain)` tests, where the node is that call. */
export function typeTestedChain(node: CelNode): string | undefined {
  if (!isTypeCall(node)) return undefined;
  return chainText(node.args[0]!);
}

/** Whether a node is a call of `type` on one argument. */
export function isTypeCall(node: CelNode): node is Extract<CelNode, { kind: "call" }> {
  return node.kind === "call" && node.name === "type" && node.args.length === 1;
}

/** The member `has(chain.member)` proves its chain holds. */
function memberTest(call: Extract<CelNode, { kind: "call" }>): readonly Proof[] {
  if (call.name !== "has" || call.args.length !== 1) return [];
  const argument = call.args[0]!;
  if (argument.kind !== "select" || argument.optional || argument.field === "") return [];
  const chain = chainText(argument.operand);
  return chain === undefined ? [] : [{ chain, member: argument.field }];
}

/** What `x == lit` (either order) proves where it holds (`holds`) or fails. */
function equalityTest(comparison: Extract<CelNode, { kind: "binary" }>, holds: boolean): readonly Proof[] {
  const { left, right } = comparison;
  const literal = literalValue(right);
  if (literal !== undefined) return comparedProofs(left, [literal.value], holds);
  const other = literalValue(left);
  return other === undefined ? [] : comparedProofs(right, [other.value], holds);
}

/** What `x in [lit, …]` proves, every element a literal written plainly. */
function membershipTest(comparison: Extract<CelNode, { kind: "binary" }>, holds: boolean): readonly Proof[] {
  const list = comparison.right;
  if (list.kind !== "list") return [];
  const values: CelValue[] = [];
  for (const element of list.elements) {
    const literal = element.optional ? undefined : literalValue(element.value);
    if (literal === undefined) return [];
    values.push(literal.value);
  }
  return comparedProofs(comparison.left, values, holds);
}

/**
 * The proofs about a compared node: its operand's member, and where the test holds, the node
 * itself — unless null is listed, since what a test against null proves of its own chain is
 * the null test's, a dereference staying the nullable read it was.
 */
function comparedProofs(compared: CelNode, values: readonly CelValue[], holds: boolean): readonly Proof[] {
  const proofs: Proof[] = [];
  const read = memberByName(compared);
  const operand = read === undefined ? undefined : chainText(read.operand);
  if (read !== undefined && operand !== undefined) proofs.push({ chain: operand, equals: { member: read.member, values, holds } });
  const chain = chainText(compared);
  if (holds && chain !== undefined && !values.includes(null)) proofs.push({ chain, equals: { values, holds } });
  return proofs;
}

/** A member read by a literal name: `.m`, or `['m']`. */
function memberByName(node: CelNode): { operand: CelNode; member: string } | undefined {
  if (node.kind === "select" && !node.optional && node.field !== "") return { operand: node.operand, member: node.field };
  if (node.kind === "index" && !node.optional && node.index.kind === "literal" && node.index.literal.type === "string") {
    return { operand: node.operand, member: node.index.literal.value };
  }
  return undefined;
}

/** The value a literal node writes, for every literal kind but bytes. */
function literalValue(node: CelNode): { value: CelValue } | undefined {
  if (node.kind !== "literal" || node.literal.type === "bytes") return undefined;
  return { value: celLiteralValue(node.literal) };
}

function isNullLiteral(node: CelNode): boolean {
  return node.kind === "literal" && node.literal.type === "null";
}
