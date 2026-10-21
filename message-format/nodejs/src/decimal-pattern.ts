/**
 * The subset of CLDR decimal patterns (UTS #35 Part 3 §3.2) the standard patterns of
 * every locale fall within: `#` and `0` integer digits with `,` grouping separators,
 * then an optional `.` with `0` and `#` fraction digits — `#,##0.###`, `#,##,##0.###`.
 * No prefix, suffix, negative subpattern, exponent or rounding increment; the data
 * generator refuses a pattern outside it.
 */

export interface DecimalPattern {
  readonly minimumIntegerDigits: number;
  readonly minimumFractionDigits: number;
  readonly maximumFractionDigits: number;
  /** Digits in the group nearest the decimal separator; 0 when the pattern groups nothing. */
  readonly primaryGrouping: number;
  /** Digits in every further group. */
  readonly secondaryGrouping: number;
}

const SUBSET = /^(?:#+,)*#*0+(?:\.0*#*)?$/;

const parsed = new Map<string, DecimalPattern>();

export function parseDecimalPattern(pattern: string): DecimalPattern {
  let found = parsed.get(pattern);
  if (found !== undefined) return found;
  if (!SUBSET.test(pattern)) throw new Error(`the decimal pattern ${JSON.stringify(pattern)} is outside the subset the core reads`);
  const [integer, fraction = ""] = pattern.split(".");
  const groups = integer.split(",");
  const primaryGrouping = groups.length > 1 ? groups[groups.length - 1].length : 0;
  found = {
    minimumIntegerDigits: integer.replace(/[^0]/g, "").length,
    minimumFractionDigits: fraction.replace(/[^0]/g, "").length,
    maximumFractionDigits: fraction.length,
    primaryGrouping,
    secondaryGrouping: groups.length > 2 ? groups[groups.length - 2].length : primaryGrouping,
  };
  parsed.set(pattern, found);
  return found;
}
