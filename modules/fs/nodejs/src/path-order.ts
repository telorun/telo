/** A code unit's rank by code point: surrogates, which spell the code points
 *  above U+FFFF, sort after the rest of the BMP. */
const rank = (unit: number): number =>
  unit >= 0xe000 ? unit - 0x800 : unit >= 0xd800 ? unit + 0x2000 : unit;

/** Orders two paths by Unicode code point over the whole path — the order of
 *  their UTF-8 bytes, which a plain string comparison (UTF-16 code units) leaves
 *  for a path holding a character above U+FFFF. */
export function comparePaths(a: string, b: string): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return rank(x) - rank(y);
  }
  return a.length - b.length;
}
