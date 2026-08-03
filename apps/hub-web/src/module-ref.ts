/** Presentation helpers for a module location ref. A ref is the module's
 *  identity (`oci://ghcr.io/telorun/console`, `oci://ghcr.io/org/team/youtrack`,
 *  `https://host/…/telo.yaml`); these only shape how it reads on screen. */

/** The memorable tail of a ref: `oci://ghcr.io/org/team/youtrack` → `youtrack`,
 *  `https://host/…/modules/sql-repository/telo.yaml` → `sql-repository`. A
 *  scanning aid only — the full ref is always shown alongside it, because the
 *  tail alone is not unique across hosts. */
export function moduleLabel(ref: string): string {
  const withoutScheme = ref.replace(/^[a-z]+:\/\//, "");
  const segments = withoutScheme
    .replace(/\/telo\.yaml$/, "")
    .split("/")
    .filter(Boolean);
  return segments[segments.length - 1] ?? ref;
}

/** What to call a module on screen: its declared `metadata.name` when the hub
 *  reports one, else the ref's memorable tail.
 *
 *  The name is what the author calls it and what the kind registry prints, so it
 *  is the better heading — a module at `.../aws/telo-s3` naming itself `S3`
 *  should read as `S3`. It is neither a locator nor unique across the
 *  federation, so the full ref is always shown with it. The fallback covers a
 *  hub that predates the field, and lives here so the rule is written once. */
export function moduleDisplayName(module: { name?: string; ref: string }): string {
  return module.name?.trim() || moduleLabel(module.ref);
}

/** `Telo.Invocable` → `Invocable` — the namespace is noise in a dense list. */
export function shortCapability(capability: string): string {
  return capability.replace(/^Telo\./, "");
}

/** The transport a ref addresses, by the same rule the hub records at
 *  registration: an explicit scheme cannot be inferred from host/path alone. */
export function transportOf(ref: string): "oci" | "url" | "registry" {
  if (ref.startsWith("oci://")) return "oci";
  if (ref.startsWith("https://")) return "url";
  return "registry";
}

/** A ref as a page path, transport-first —
 *  `oci://ghcr.io/telorun/console` → `/module/oci/ghcr.io/telorun/console`.
 *
 *  Deliberately the same `<transport>/<host>/<path…>` shape the manifest cache
 *  keys use, so one mental model covers a module's URL here and its cached
 *  manifest. A percent-encoded ref in one segment would round-trip too, but it
 *  reads as opaque and defeats the point of a shareable link. */
export function refToPath(ref: string): string {
  const transport = transportOf(ref);
  const bare = ref.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  return `/module/${transport}/${bare}`;
}

/** Inverse of `refToPath`; `null` when the path is not a module route. */
export function refFromPath(pathname: string): string | null {
  const match = /^\/module\/(oci|url|registry)\/(.+)$/.exec(pathname.replace(/\/+$/, ""));
  if (!match) return null;
  const [, transport, bare] = match;
  if (transport === "oci") return `oci://${bare}`;
  if (transport === "url") return `https://${bare}`;
  return bare;
}
