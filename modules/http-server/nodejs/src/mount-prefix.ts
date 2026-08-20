/**
 * Collapse a mount prefix to a single leading slash with no trailing slash; an
 * empty/`"/"` prefix becomes `"/"`.
 *
 * Shared by the mounts that hand their prefix to a Fastify plugin — Http.Static's
 * encapsulated `register({ prefix })` and Http.Reference's `routePrefix` — both of
 * which need a non-empty prefix, hence root maps to `"/"`. Http.Api is the odd one
 * out: it returns `""` and concatenates the prefix onto each route path on the
 * root app, so it does not use this.
 */
export function normalizeMountPrefix(prefix: string): `/${string}` {
  const trimmed = prefix.replace(/\/+$/, "");
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? (trimmed as `/${string}`) : `/${trimmed}`;
}
