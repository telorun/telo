/** The source text of a text as written — a string, a record, or a bound text
 *  holding one — taking `other` at every selection; `""` for anything else. */
function sourceOf(text: unknown): string {
  let at = text;
  while (at !== null && typeof at === "object" && "text" in at) at = at.text;
  while (at !== null && typeof at === "object" && "cases" in at) at = (at as { cases: Record<string, unknown> }).cases.other;
  return typeof at === "string" ? at : "";
}

/** A source text as a key: lower case, accents dropped, every run of anything
 *  but letters and digits one `-`. Never holds `/` or `~`, nor starts with `-`. */
function slug(source: string): string {
  return source
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The keys of siblings, in declaration order, from the source text each was
 * written with: its slug — `fallback` when it has none — after `prefix`, and
 * `~2`, `~3`, … on each later sibling of a key already taken. A key depends
 * only on what was written, so an entry gated off or added elsewhere moves no
 * other entry's key.
 */
export function sourceKeys(texts: readonly unknown[], fallback: string, prefix = ""): string[] {
  const taken = new Map<string, number>();
  return texts.map((text) => {
    const key = `${prefix}${slug(sourceOf(text)) || fallback}`;
    const seen = (taken.get(key) ?? 0) + 1;
    taken.set(key, seen);
    return seen === 1 ? key : `${key}~${seen}`;
  });
}
