/**
 * Canonical JSON: a rendering under which two structurally equal values produce
 * the same string — object keys sorted, `undefined`-valued entries dropped.
 *
 * Shared rather than duplicated because both readers compare the RESULT for
 * equality: `contentKey` anchors a module-graph row's identity to its content so
 * an inserted sibling does not move it, and `declarationSignature` decides
 * whether a resource has to be rebuilt. Two implementations would eventually
 * disagree about key order or about `undefined`, and the disagreement surfaces
 * as a row that silently changes identity, or as a resource that silently fails
 * to restart.
 *
 * Browser-safe: no hashing, no `node:crypto`. Callers that only need equality
 * compare the strings, which cannot collide; a caller that needs a short key
 * hashes it itself.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
