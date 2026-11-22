/** `text` without its trailing `/` characters, scanned once from the end. */
export function trimTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === "/") end--;
  return text.slice(0, end);
}
