/** Presentation helpers for a module location ref. A ref is the module's
 *  identity (`std/console`, `oci://ghcr.io/org/team/youtrack`,
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

/** `Telo.Invocable` → `Invocable` — the namespace is noise in a dense list. */
export function shortCapability(capability: string): string {
  return capability.replace(/^Telo\./, "");
}
