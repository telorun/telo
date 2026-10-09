import type { HostStore } from "./host.js";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const ABSOLUTE = /^(https:\/\/|http:\/\/|mailto:)/;

/**
 * The application path a URL names, the mount prefix removed: nothing for a URL
 * on another origin, outside the mount, or under the reserved `/_telo`.
 */
export function applicationPath(prefix: string, href: string): string | undefined {
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin) return undefined;
  if (prefix !== "" && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return undefined;
  const path = url.pathname.slice(prefix.length) || "/";
  return path === "/_telo" || path.startsWith("/_telo/") ? undefined : path;
}

/**
 * Where a link to an address leads, or nothing when the address is not one a
 * link may hold. An app-relative path is the application's own, so it resolves
 * under the mount, and one a browser would read as another host does not
 * resolve; anything else must begin `https://`, `http://` or `mailto:`.
 */
export function linkAddress(store: HostStore, address: string): string | undefined {
  if (address.startsWith("/")) return CONTROL_CHARACTER.test(address) ? undefined : store.localHref(address);
  return ABSOLUTE.test(address) ? address : undefined;
}
