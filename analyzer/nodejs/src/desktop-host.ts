/**
 * DESKTOP HOST — the kernel-declared need type a desktop application asks the
 * desktop shell for. Its `port` parameter names a `tcp` key of the root's
 * `ports:`, the rule the address need types share (`public-address.ts`), and
 * its `callbackPaths` are literal app-relative paths. Browser-safe.
 */

import { isAddressNeedType } from "./public-address.js";

export const DESKTOP_HOST_TYPE = "Telo.DesktopHost";

/** A need type whose `port` parameter names a `tcp` key of `ports:` and which a
 *  library declares with no parameters. */
export function isPortNeedType(type: string | undefined): boolean {
  return isAddressNeedType(type) || type === DESKTOP_HOST_TYPE;
}

/** Why a callback path is not a literal app-relative path, or undefined. */
export function callbackPathRefusal(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  if (!path.startsWith("/")) return `'${path}' must start with '/'`;
  if (path.includes("?") || path.includes("#")) {
    return `'${path}' must hold no query or fragment`;
  }
  return undefined;
}
