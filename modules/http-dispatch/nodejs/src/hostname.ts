/**
 * Hostname matching for an HTTP transport's `hostnames` matcher: which entry a
 * request's host selects, with the one precedence every transport applies —
 * an exact host first, then the pattern with the longest literal suffix.
 *
 * An entry is read from the fulfilment of an address need: a `Telo.PublicUrl`
 * matches its URL's host exactly, a `Telo.PublicHostPattern` every host its
 * pattern matches. `*` stands only at the start of the first label — the whole
 * label (`*.a.example`, one or more labels) or a prefix of it (`*-a.example`,
 * characters inside that label).
 */

export type HostnameMatcher =
  | { readonly kind: "exact"; readonly host: string }
  | { readonly kind: "pattern"; readonly form: "label" | "prefix"; readonly suffix: string };

/** A host as matched: lowercased, its port and a trailing dot dropped, an IPv6
 *  literal kept in brackets. */
export function normalizeRequestHost(host: string): string {
  let out = host.trim().toLowerCase();
  if (out.startsWith("[")) {
    const end = out.indexOf("]");
    return end === -1 ? out : out.slice(0, end + 1);
  }
  const colon = out.lastIndexOf(":");
  if (colon !== -1 && /^[0-9]*$/.test(out.slice(colon + 1))) out = out.slice(0, colon);
  return out.replace(/\.$/, "");
}

/** Whether a normalized host is an IP literal — IPv4, or IPv6 in brackets. */
export function isIpLiteral(host: string): boolean {
  if (host.startsWith("[")) return true;
  return /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host);
}

/** The matcher a host or a host pattern (`*.a.example`, `*-a.example`) is. */
export function hostnameMatcher(host: string): HostnameMatcher | undefined {
  const normalized = normalizeRequestHost(host);
  if (!normalized.startsWith("*")) return normalized ? { kind: "exact", host: normalized } : undefined;
  const suffix = normalized.slice(1);
  if (suffix.startsWith(".") && suffix.length > 1) return { kind: "pattern", form: "label", suffix };
  if (/^[a-z0-9-]+\.[a-z0-9]/.test(suffix)) return { kind: "pattern", form: "prefix", suffix };
  return undefined;
}

/** The matcher a pattern origin (`https://*.a.example:8443`) holds. */
export function hostnameMatcherOfOrigin(origin: string): HostnameMatcher | undefined {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(origin);
  return match ? hostnameMatcher(match[1]!) : undefined;
}

/** How strongly `matcher` claims `host` (normalized): `Infinity` for an exact
 *  host, the literal suffix's length for a pattern, `undefined` for none. */
export function hostnameClaim(matcher: HostnameMatcher, host: string): number | undefined {
  if (matcher.kind === "exact") return matcher.host === host ? Number.POSITIVE_INFINITY : undefined;
  if (!host.endsWith(matcher.suffix) || host.length === matcher.suffix.length) return undefined;
  const head = host.slice(0, host.length - matcher.suffix.length);
  if (matcher.form === "prefix" && head.includes(".")) return undefined;
  if (matcher.form === "label" && (head.startsWith(".") || head.endsWith("."))) return undefined;
  return matcher.suffix.length;
}

/** Whether two matchers claim exactly the same hosts. */
export function sameHostnameMatcher(a: HostnameMatcher, b: HostnameMatcher): boolean {
  if (a.kind === "exact" || b.kind === "exact") {
    return a.kind === "exact" && b.kind === "exact" && a.host === b.host;
  }
  return a.form === b.form && a.suffix === b.suffix;
}

/** How a matcher is written, for a message. */
export function describeHostnameMatcher(matcher: HostnameMatcher): string {
  return matcher.kind === "exact" ? matcher.host : `*${matcher.suffix}`;
}
