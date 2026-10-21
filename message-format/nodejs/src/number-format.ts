/**
 * A number's text and its plural category, from its value alone — never its host
 * type, so the double `1.0` and the integer `1` are both "1" and `one` in `en`.
 *
 * - An integer (a `bigint` inside int64 ∪ uint64) is written exactly, however large.
 * - A double is its shortest round-trip decimal, rounded half-to-even to the
 *   pattern's maximum fraction digits, trailing zeros dropped down to its minimum; a
 *   result of zero is unsigned. A non-finite double is refused.
 * - The text then takes the language's CLDR standard decimal pattern, grouping
 *   (with `minimumGroupingDigits`), digits, decimal separator and minus sign.
 *
 * Plural selection reads the operands of that rounded decimal, so it agrees with the
 * text: `1.0004` is "1" and selects `one`.
 */

import { numberEntryFor, pluralRuleSetFor } from "./cldr-locale.js";
import type { CldrNumberEntry } from "./cldr-tables.js";
import { parseDecimalPattern } from "./decimal-pattern.js";
import type { PluralCategory } from "./message-model.js";
import { MessageFormatError } from "./message-problem.js";
import { operandsOfDecimal, type PluralOperands } from "./plural-operands.js";
import { pluralRuleHolds } from "./plural-rule.js";

/** A number the core formats: a double, or an integer inside int64 ∪ uint64. */
export type NumberValue = number | bigint;

/** A number after rounding: ASCII digits, the integer part without leading zeros. */
export interface RoundedDecimal {
  readonly negative: boolean;
  readonly integer: string;
  readonly fraction: string;
}

const INT64_MIN = -(2n ** 63n);
const UINT64_MAX = 2n ** 64n - 1n;

/** Why `value` is no number the core formats, worded about `subject`; `null` when it is one. */
export function numberRefusal(value: unknown, subject: string): string | null {
  if (typeof value === "bigint") {
    return value < INT64_MIN || value > UINT64_MAX ? `${subject} is an integer outside the 64-bit range` : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? null : `${subject} is not a finite number`;
  return `${subject} is not a number`;
}

/** The significant digits of `|value|` and where the decimal point sits among them. */
function significantDigits(value: NumberValue): { digits: string; point: number } {
  let digits: string;
  let point: number;
  if (typeof value === "bigint") {
    digits = (value < 0n ? -value : value).toString();
    point = digits.length;
  } else {
    const [mantissa, exponent = "0"] = String(Math.abs(value)).split("e");
    const [integer, fraction = ""] = mantissa.split(".");
    digits = integer + fraction;
    point = integer.length + Number(exponent);
  }
  const leading = digits.length - digits.replace(/^0+/, "").length;
  return { digits: digits.slice(leading).replace(/0+$/, ""), point: point - leading };
}

/** Adds one to the last digit, carrying; a carry out of the first digit adds a digit. */
function incremented(digits: string): { digits: string; carried: boolean } {
  const out = digits.split("");
  for (let index = out.length - 1; index >= 0; index -= 1) {
    if (out[index] !== "9") {
      out[index] = String.fromCharCode(out[index].charCodeAt(0) + 1);
      return { digits: out.join(""), carried: false };
    }
    out[index] = "0";
  }
  return { digits: `1${out.join("")}`, carried: true };
}

export function roundedDecimal(value: NumberValue, pattern: string): RoundedDecimal {
  const { minimumIntegerDigits, minimumFractionDigits, maximumFractionDigits } = parseDecimalPattern(pattern);
  let { digits, point } = significantDigits(value);
  const keep = point + maximumFractionDigits;
  if (keep < 0) {
    digits = "";
  } else if (keep < digits.length) {
    const kept = digits.slice(0, keep);
    const first = digits[keep];
    const restNonZero = /[1-9]/.test(digits.slice(keep + 1));
    const last = keep > 0 ? kept.charCodeAt(keep - 1) - 48 : 0;
    const up = first > "5" || (first === "5" && (restNonZero || last % 2 === 1));
    if (up) {
      const next = incremented(kept);
      digits = next.digits;
      if (next.carried) point += 1;
    } else {
      digits = kept;
    }
  }
  let integer = point > 0 ? (digits.slice(0, point) + "0".repeat(Math.max(0, point - digits.length))) : "";
  let fraction = point >= 0 ? digits.slice(point) : "0".repeat(-point) + digits;
  fraction = fraction.replace(/0+$/, "");
  fraction += "0".repeat(Math.max(0, minimumFractionDigits - fraction.length));
  integer = integer.replace(/^0+/, "");
  const zero = integer === "" && !/[1-9]/.test(fraction);
  integer = integer.padStart(Math.max(1, minimumIntegerDigits), "0");
  const negative = !zero && (typeof value === "bigint" ? value < 0n : value < 0);
  return { negative, integer, fraction };
}

export function decimalOperands(decimal: RoundedDecimal): PluralOperands {
  return { integer: decimal.integer.replace(/^0+(?=.)/, ""), fraction: decimal.fraction, exponent: 0 };
}

/** Whether the rounded decimal equals the canonical integer `exact` numerically. */
export function decimalEquals(decimal: RoundedDecimal, exact: string): boolean {
  if (/[1-9]/.test(decimal.fraction)) return false;
  const integer = decimal.integer.replace(/^0+(?=.)/, "");
  return (decimal.negative ? `-${integer}` : integer) === exact;
}

export function localizedDecimal(decimal: RoundedDecimal, entry: CldrNumberEntry): string {
  const { primaryGrouping, secondaryGrouping } = parseDecimalPattern(entry.pattern);
  const digits = Array.from(entry.digits);
  const localDigits = (ascii: string): string => Array.from(ascii, (digit) => digits[digit.charCodeAt(0) - 48]).join("");
  let integer = decimal.integer;
  if (primaryGrouping > 0 && integer.length >= primaryGrouping + Number(entry.minimumGroupingDigits)) {
    const groups = [integer.slice(-primaryGrouping)];
    integer = integer.slice(0, -primaryGrouping);
    while (integer.length > secondaryGrouping) {
      groups.unshift(integer.slice(-secondaryGrouping));
      integer = integer.slice(0, -secondaryGrouping);
    }
    if (integer !== "") groups.unshift(integer);
    integer = groups.map(localDigits).join(entry.group);
  } else {
    integer = localDigits(integer);
  }
  const fraction = decimal.fraction === "" ? "" : entry.decimal + localDigits(decimal.fraction);
  return (decimal.negative ? entry.minusSign : "") + integer + fraction;
}

export function categoryOfOperands(operands: PluralOperands, lang: string): PluralCategory {
  for (const [category, rule] of pluralRuleSetFor(lang).rules) if (pluralRuleHolds(rule, operands)) return category;
  return "other";
}

function checkedNumber(value: unknown): NumberValue {
  const refusal = numberRefusal(value, "the value");
  if (refusal !== null) throw new MessageFormatError("MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED", refusal);
  return value as NumberValue;
}

export function formatNumber(value: NumberValue, lang: string): string {
  const entry = numberEntryFor(lang);
  return localizedDecimal(roundedDecimal(checkedNumber(value), entry.pattern), entry);
}

export function pluralCategory(value: NumberValue, lang: string): PluralCategory {
  const decimal = roundedDecimal(checkedNumber(value), numberEntryFor(lang).pattern);
  return categoryOfOperands(decimalOperands(decimal), lang);
}

/** The category of a decimal written as UTS #35 writes its samples (`1.0`, `1c6`). */
export function pluralCategoryOfDecimal(text: string, lang: string): PluralCategory {
  const operands = operandsOfDecimal(text);
  if (operands === null) throw new RangeError(`${JSON.stringify(text)} is not a decimal number`);
  return categoryOfOperands(operands, lang);
}
