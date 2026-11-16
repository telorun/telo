import type { HostStore } from "./host.js";
import { matchPage } from "./page-route.js";

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

/**
 * Where following an address moves within the application: the path, query and
 * fragment of an address one of its declared pages opens — matched segment by
 * segment — or nothing, when following it is an ordinary load.
 */
export function pageAddress(prefix: string, pages: readonly string[], href: string): string | undefined {
  const target = applicationPath(prefix, href);
  if (target === undefined || matchPage(pages, target) === undefined) return undefined;
  const url = new URL(href, window.location.href);
  return target + url.search + url.hash;
}

/**
 * Where a plain click on an anchor to a page the application declares moves
 * within it, the click taken from the browser; nothing for any other click,
 * which stays the browser's.
 */
export function anchorMove(
  event: Pick<MouseEvent, "defaultPrevented" | "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "target" | "preventDefault">,
  prefix: string,
  pages: readonly string[],
): string | undefined {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return undefined;
  const anchor = (event.target as Element).closest?.("a");
  const href = anchor?.getAttribute("href");
  if (!anchor || href == null || anchor.getAttribute("target") || anchor.hasAttribute("download")) return undefined;
  const to = pageAddress(prefix, pages, href);
  if (to !== undefined) event.preventDefault();
  return to;
}
