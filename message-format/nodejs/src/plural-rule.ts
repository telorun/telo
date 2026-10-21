/**
 * A UTS #35 plural rule (Part 3 §5.1): a condition of relations joined by `and` and
 * `or` (`and` binding tighter), each relation an operand, an optional `% m`, `=` or
 * `!=`, and a list of values and `a..b` ranges. A range holds integers only, so `n`
 * with a non-zero fraction is in none. The samples after `@` are not part of the rule.
 */

import { operandDigits, type OperandName, type PluralOperands } from "./plural-operands.js";

export interface PluralRelation {
  readonly operand: OperandName;
  readonly modulus: number | null;
  readonly equal: boolean;
  readonly ranges: readonly (readonly [number, number])[];
}

/** Alternatives, each a conjunction of relations; empty holds always. */
export type PluralRule = readonly (readonly PluralRelation[])[];

const OPERANDS: ReadonlySet<string> = new Set(["n", "i", "v", "w", "f", "t", "c", "e"]);
const TOKEN = /\s*(\.\.|!=|[=%,]|[a-z]+|[0-9]+)/y;
/** Above this a value's digits are never compared as a number: every bound is below it. */
const LARGEST_BOUND = 1e15;

export function parsePluralRule(written: string): PluralRule {
  const condition = written.split("@")[0];
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < condition.length) {
    if (/^\s*$/.test(condition.slice(TOKEN.lastIndex))) break;
    const match = TOKEN.exec(condition);
    if (match === null) throw new Error(`the plural rule ${JSON.stringify(written)} does not read`);
    tokens.push(match[1]);
  }
  let at = 0;
  const fail = (): never => {
    throw new Error(`the plural rule ${JSON.stringify(written)} does not read at token ${at}`);
  };
  const number = (): number => {
    const token = tokens[at++];
    if (token === undefined || !/^[0-9]+$/.test(token)) fail();
    const value = Number(token);
    if (value >= LARGEST_BOUND) fail();
    return value;
  };
  const rule: PluralRelation[][] = [];
  if (tokens.length === 0) return rule;
  let conjunction: PluralRelation[] = [];
  for (;;) {
    const operand = tokens[at++];
    if (operand === undefined || !OPERANDS.has(operand)) fail();
    let modulus: number | null = null;
    if (tokens[at] === "%") {
      at += 1;
      modulus = number();
      if (modulus === 0) fail();
    }
    const comparison = tokens[at++];
    if (comparison !== "=" && comparison !== "!=") fail();
    const ranges: [number, number][] = [];
    for (;;) {
      const low = number();
      let high = low;
      if (tokens[at] === "..") {
        at += 1;
        high = number();
      }
      ranges.push([low, high]);
      if (tokens[at] !== ",") break;
      at += 1;
    }
    conjunction.push({ operand: operand as OperandName, modulus, equal: comparison === "=", ranges });
    const joiner = tokens[at++];
    if (joiner === undefined) break;
    if (joiner === "or") {
      rule.push(conjunction);
      conjunction = [];
    } else if (joiner !== "and") {
      fail();
    }
  }
  rule.push(conjunction);
  return rule;
}

/** `digits` modulo `modulus`, read a digit at a time so any length is exact. */
function remainder(digits: string, modulus: number): number {
  let value = 0;
  for (let index = 0; index < digits.length; index += 1) value = (value * 10 + (digits.charCodeAt(index) - 48)) % modulus;
  return value;
}

function holds(relation: PluralRelation, operands: PluralOperands): boolean {
  const digits = operandDigits(operands, relation.operand);
  let inRange = false;
  if (digits !== null) {
    const value =
      relation.modulus !== null ? remainder(digits, relation.modulus) : digits.length > 15 ? null : Number(digits);
    inRange = value !== null && relation.ranges.some(([low, high]) => value >= low && value <= high);
  }
  return inRange === relation.equal;
}

export function pluralRuleHolds(rule: PluralRule, operands: PluralOperands): boolean {
  if (rule.length === 0) return true;
  return rule.some((conjunction) => conjunction.every((relation) => holds(relation, operands)));
}
