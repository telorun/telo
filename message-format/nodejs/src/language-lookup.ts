/**
 * RFC 4647 lookup (§3.4): a requested tag is truncated one subtag at a time, a
 * singleton (or run of them) left at the end going with the subtag after it, and the first tag
 * available wins — `pl-Latn-PL` → `pl-Latn` → `pl`. Tags compare case-insensitively
 * (ASCII), and the answer is the available tag as it was written. No match means the
 * caller falls back to its source.
 */

export function asciiLowercase(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

export function truncationChain(tag: string): readonly string[] {
  if (tag === "") return [];
  const chain = [tag];
  const subtags = tag.split("-");
  while (subtags.length > 1) {
    subtags.pop();
    while (subtags.length > 1 && subtags[subtags.length - 1].length === 1) subtags.pop();
    chain.push(subtags.join("-"));
  }
  return chain;
}

export function lookupLanguage(requested: string, available: Iterable<string>): string | null {
  const byKey = new Map<string, string>();
  for (const tag of available) {
    const key = asciiLowercase(tag);
    if (!byKey.has(key)) byKey.set(key, tag);
  }
  for (const tag of truncationChain(requested)) {
    const found = byKey.get(asciiLowercase(tag));
    if (found !== undefined) return found;
  }
  return null;
}
