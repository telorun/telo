/** True when `source` names an on-disk sibling manifest — a relative (`./`,
 *  `../`) or absolute (`/`) path — rather than a transport-owned remote ref. */
export function isLocalPathSource(source: string): boolean {
  return source.startsWith(".") || source.startsWith("/");
}
