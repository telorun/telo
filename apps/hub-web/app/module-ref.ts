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

/** One segment of a page-bearing ref: the unencoded RFC 3986 path alphabet. */
const PAGE_SEGMENT = /^[A-Za-z0-9\-._~!$&'()*+,;=:@]+$/;

const PAGE_TRANSPORTS = [
  { scheme: "oci://", transport: "oci" },
  { scheme: "https://", transport: "url" },
] as const;

/** A ref's page path, or `null` when the ref has no page.
 *
 *  A ref has a page when it is `oci://` or `https://` followed by one or more
 *  `/`-separated segments, each non-empty, not `.` or `..`, and written only in
 *  the unencoded path alphabet `A-Z a-z 0-9 - . _ ~ ! $ & ' ( ) * + , ; = : @`.
 *  Its page is `/module/oci/<rest>/` or `/module/url/<rest>/`, `<rest>` copied
 *  verbatim — the same `<transport>/<host>/<path…>` shape the manifest cache
 *  keys use. Every other ref (a `./` local ref, `http://`, anything holding `%`,
 *  `?`, `#`, `\`, a space, a control or a non-ASCII character) has no page:
 *  such a path would not read back as the same ref. Every module link is built
 *  here, so none points at a path the server refuses. */
export function modulePagePath(ref: string): string | null {
  for (const { scheme, transport } of PAGE_TRANSPORTS) {
    if (!ref.startsWith(scheme)) continue;
    const rest = ref.slice(scheme.length);
    const pageBearing = rest
      .split("/")
      .every((segment) => PAGE_SEGMENT.test(segment) && segment !== "." && segment !== "..");
    return pageBearing ? `/module/${transport}/${rest}/` : null;
  }
  return null;
}

/** The ref a module path names, from the part after `/module/`
 *  (`oci/ghcr.io/telorun/console/`), trailing slashes ignored; `null` when it
 *  names neither `oci` nor `url`. Whether that ref has a page is
 *  `modulePagePath`'s to say. */
export function refFromPath(splat: string): string | null {
  const match = /^(oci|url)\/(.+)$/.exec(splat.replace(/\/+$/, ""));
  if (!match) return null;
  const [, transport, rest] = match;
  return transport === "oci" ? `oci://${rest}` : `https://${rest}`;
}
