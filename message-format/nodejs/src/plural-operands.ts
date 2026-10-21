/**
 * The operands of a number as written (UTS #35 Part 3 §5.1): `n` its absolute value,
 * `i` its integer digits, `v` / `f` its visible fraction digits (their count / their
 * value), `w` / `t` the same without trailing zeros, and `c` / `e` the compact
 * exponent. The digits are kept as text, so an integer of any size is exact.
 */

export interface PluralOperands {
  /** Integer digits with no leading zero (`"0"` for none). */
  readonly integer: string;
  /** Fraction digits as written, trailing zeros included. */
  readonly fraction: string;
  /** The `c` / `e` exponent of a compact number; 0 for every number the core formats. */
  readonly exponent: number;
}

const DECIMAL = /^-?([0-9]+)(?:\.([0-9]+))?(?:[ce]([0-9]+))?$/;

function withoutLeadingZeros(digits: string): string {
  const stripped = digits.replace(/^0+/, "");
  return stripped === "" ? "0" : stripped;
}

/**
 * The operands of a decimal written as UTS #35 writes its samples: an optional `-`,
 * digits, an optional fraction, and an optional `c` / `e` exponent (`1.2c3` is 1200
 * with `c` = 3). `null` when the text is not one.
 */
export function operandsOfDecimal(text: string): PluralOperands | null {
  const match = DECIMAL.exec(text);
  if (match === null) return null;
  const exponent = match[3] === undefined ? 0 : Number(match[3]);
  if (!Number.isSafeInteger(exponent)) return null;
  const integer = match[1];
  const fraction = match[2] ?? "";
  const digits = integer + fraction;
  const point = integer.length + exponent;
  return {
    integer: withoutLeadingZeros(point >= digits.length ? digits + "0".repeat(point - digits.length) : digits.slice(0, point)),
    fraction: point >= digits.length ? "" : digits.slice(point),
    exponent,
  };
}

export type OperandName = "n" | "i" | "v" | "w" | "f" | "t" | "c" | "e";

/** An operand's value: integer digits, or `null` for an `n` with a non-zero fraction,
 *  which equals no integer. */
export function operandDigits(operands: PluralOperands, name: OperandName): string | null {
  const trimmed = operands.fraction.replace(/0+$/, "");
  switch (name) {
    case "n":
      return trimmed === "" ? operands.integer : null;
    case "i":
      return operands.integer;
    case "v":
      return String(operands.fraction.length);
    case "w":
      return String(trimmed.length);
    case "f":
      return withoutLeadingZeros(operands.fraction);
    case "t":
      return withoutLeadingZeros(trimmed);
    case "c":
    case "e":
      return String(operands.exponent);
  }
}
