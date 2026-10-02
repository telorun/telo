/**
 * Integer arithmetic: 64-bit, checked, and **never wrapped**.
 *
 * CEL's `int` is a signed 64-bit integer and its `uint` an unsigned one. A result
 * outside the range is an error, not a wrap: an engine that wraps answers a value no
 * other engine answers, and a manifest that silently computes `-9223372036854775808`
 * from a sum of positives is worse than one that fails. The vectors pin this as the
 * domain-keeping answer where the engine being replaced returns a number beyond int64.
 *
 * Division truncates toward zero and the modulo takes the dividend's sign, which is
 * what `BigInt` already does; division and modulo by zero are errors of their own, so a
 * reader of the code knows which one happened.
 */

import { celError, celUint, type CelError, type CelUint } from "./cel-value.js";
import { MAX_INT, MAX_UINT, MIN_INT } from "./lexer.js";
import type { SourceRange } from "./syntax-tree.js";

const MAX_UINT_PLUS_ONE = MAX_UINT + 1n;

function overflow(range: SourceRange | undefined, result: bigint, what: string): CelError {
  return celError("numeric_overflow", `${what} overflow: ${result}`, range);
}

/** An int result, or the overflow it is outside the range. */
export function intResult(value: bigint, range?: SourceRange): bigint | CelError {
  if (value < MIN_INT || value > MAX_INT) return overflow(range, value, "integer");
  return value;
}

/** A uint result, or the overflow it is outside the range. */
export function uintResult(value: bigint, range?: SourceRange): CelUint | CelError {
  if (value < 0n || value > MAX_UINT) return overflow(range, value, "unsigned integer");
  return celUint(value);
}

export function intDivide(left: bigint, right: bigint, range?: SourceRange): bigint | CelError {
  if (right === 0n) return celError("division_by_zero", "division by zero", range);
  return intResult(left / right, range);
}

export function intModulo(left: bigint, right: bigint, range?: SourceRange): bigint | CelError {
  if (right === 0n) return celError("modulo_by_zero", "modulus by zero", range);
  return intResult(left % right, range);
}

export function uintDivide(left: bigint, right: bigint, range?: SourceRange): CelUint | CelError {
  if (right === 0n) return celError("division_by_zero", "division by zero", range);
  return uintResult(left / right, range);
}

export function uintModulo(left: bigint, right: bigint, range?: SourceRange): CelUint | CelError {
  if (right === 0n) return celError("modulo_by_zero", "modulus by zero", range);
  return uintResult(left % right, range);
}

/** Whether a magnitude fits a uint64 — used by the conversions. */
export function fitsUint(value: bigint): boolean {
  return value >= 0n && value < MAX_UINT_PLUS_ONE;
}

export function fitsInt(value: bigint): boolean {
  return value >= MIN_INT && value <= MAX_INT;
}
