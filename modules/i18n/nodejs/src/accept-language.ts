/**
 * An Accept-Language value (RFC 9110 §12.5.4) read leniently, since it comes from
 * a client: a malformed range or quality is skipped, `*` is skipped (lookup has no
 * use for it), a range of quality 0 is dropped, and the rest is ordered by quality,
 * written order breaking ties.
 */

const RANGE = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;
const QUALITY = /^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/;

export function languagePreferences(header: string): string[] {
  const ranked: { range: string; quality: number; at: number }[] = [];
  header.split(",").forEach((part, at) => {
    const [range, ...parameters] = part.split(";").map((piece) => piece.trim());
    if (!range || !RANGE.test(range)) return;
    let quality = 1;
    for (const parameter of parameters) {
      const [name, value] = parameter.split("=").map((piece) => piece.trim());
      if (name?.toLowerCase() !== "q") continue;
      if (value === undefined || !QUALITY.test(value)) return;
      quality = Number(value);
    }
    if (quality > 0) ranked.push({ range, quality, at });
  });
  ranked.sort((a, b) => b.quality - a.quality || a.at - b.at);
  return ranked.map(({ range }) => range);
}
