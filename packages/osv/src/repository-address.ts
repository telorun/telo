/** `value` without its trailing `/` characters, in one pass. */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}

const SCHEME = /^[a-z][a-z0-9+.-]*$/i;
const LINE_TERMINATORS = /[\n\r\u2028\u2029]/;

/** A repository address as OSV writes it: no trailing `/` or `.git`, scheme and host lower-cased, the path as written. */
export function normalizeRepository(url: string): string {
  let trimmed = stripTrailingSlashes(url);
  if (trimmed.endsWith(".git")) trimmed = trimmed.slice(0, -".git".length);
  const marker = trimmed.indexOf("://");
  if (marker <= 0) return trimmed;
  const scheme = trimmed.slice(0, marker);
  if (!SCHEME.test(scheme)) return trimmed;
  const rest = trimmed.slice(marker + 3);
  if (LINE_TERMINATORS.test(rest)) return trimmed;
  const slash = rest.indexOf("/");
  const host = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "" : rest.slice(slash);
  return `${scheme.toLowerCase()}://${host.toLowerCase()}${path}`;
}
