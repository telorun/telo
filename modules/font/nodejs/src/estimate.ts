/**
 * Width estimation for a family that declared no face bytes.
 *
 * A layout has to place text whether or not the typeface is in hand, so the
 * alternative to estimating is refusing to render — which would make declaring
 * a websafe family useless. The estimate is deliberately crude and deliberately
 * REPORTED: `Font.Measure` returns `exact: false`, so a caller knows its
 * measurements carry slack it did not choose.
 *
 * The ratios are advance width over em for a typical humanist sans (the class
 * of face `sans-serif` resolves to on every platform), bucketed by character
 * class. Per-character rather than a flat average because the error that
 * matters is a run of one class — a column of digits, an all-caps heading —
 * where an average built from prose is wrong in one direction for every glyph.
 *
 * Held in HUNDREDTHS of an em and divided once at the end. Scaling each ratio
 * separately accumulates binary rounding into a width whose last digits are
 * noise, which is invisible in a layout and painful in anything that compares
 * two measurements.
 */

const NARROW = new Set("iljt.,:;!|'`I()[]{}/\\");
const WIDE = new Set("mwMW@%");
const CAPS_AND_DIGITS = /[A-Z0-9]/;

/** Hundredths of an em one character advances by. */
function ratio(char: string): number {
  if (char === " ") return 26;
  if (NARROW.has(char)) return 31;
  if (WIDE.has(char)) return 86;
  if (CAPS_AND_DIGITS.test(char)) return 60;
  // Anything beyond Latin — CJK, emoji — is very nearly square in every face
  // that has it, and treating it as lowercase Latin would underestimate by 2x.
  if (char.codePointAt(0)! > 0x2e7f) return 100;
  return 52;
}

export function estimateWidth(text: string, size: number): number {
  let hundredths = 0;
  for (const char of text) hundredths += ratio(char);
  return (size * hundredths) / 100;
}

/** Vertical metrics as hundredths of an em, close enough across sans faces that
 *  the estimate never decides a line height by more than a pixel or two. */
const VERTICAL = { ascender: 80, descender: 20, lineGap: 20 };

export function estimateVertical(size: number): {
  ascender: number;
  descender: number;
  lineGap: number;
} {
  return {
    ascender: (size * VERTICAL.ascender) / 100,
    descender: (size * VERTICAL.descender) / 100,
    lineGap: (size * VERTICAL.lineGap) / 100,
  };
}
