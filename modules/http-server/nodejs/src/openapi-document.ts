/** The OpenAPI version every generated document declares; `QUERY` operations exist only from 3.2. */
export const OPENAPI_VERSION = "3.2.0";

type PathItems = Record<string, Record<string, unknown>>;

/** The server's own document pass: the library's `normalize`d output with the
 *  version written and each `query` operation of the collected document kept,
 *  whatever the normalizer did with either. */
export function finalizeDocument(
  collected: Record<string, unknown>,
  normalized: Record<string, unknown>,
): Record<string, unknown> {
  const from = (collected.paths ?? {}) as PathItems;
  const paths: PathItems = { ...((normalized.paths ?? {}) as PathItems) };
  for (const [path, item] of Object.entries(from)) {
    if (item.query === undefined) continue;
    paths[path] = { ...(paths[path] ?? {}), query: item.query };
  }
  return { ...normalized, openapi: OPENAPI_VERSION, paths };
}
