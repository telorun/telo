import type { HeaderReads } from "@telorun/ui";

// Which headers an expression reads is the vocabulary's rule: a page reports its
// own, and the application reads its header, tokens and language the same way.
export { headerReads, unionReads, type HeaderReads } from "@telorun/ui";

/** `Vary`'s value for what was read: the header names, each as HTTP writes it. */
export function varyHeader(reads: HeaderReads): string | undefined {
  if (reads === "*") return "*";
  if (reads.size === 0) return undefined;
  return [...reads]
    .sort()
    .map((name) => name.replace(/(?:^|-)[a-z]/g, (start) => start.toUpperCase()))
    .join(", ");
}
