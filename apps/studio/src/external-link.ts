import { isTauri } from "@tauri-apps/api/core";
import { toast } from "sonner";

/**
 * Opening a URL outside the editor.
 *
 * A browser tab needs nothing here — an anchor with `target="_blank"` already
 * works. A Tauri webview has no handler for external navigation, so the same
 * anchor is simply inert: every link to a running app's endpoint, the
 * inspection UI, and anything the agent writes as markdown does nothing at all
 * when clicked. The defect is one fact about the app rather than a property of
 * each link, so the repair is one delegated listener installed at startup
 * instead of a callback threaded through every component that renders a URL —
 * which is also what keeps `@telorun/debug-ui`, where most of those links live,
 * browser-safe and free of any Tauri import.
 */

/** Schemes handed to the host. Matches the `opener:allow-default-urls` scope the
 *  Tauri capability grants, so a URL that reaches the plugin is one the
 *  capability admits — a wider set here would fail at the permission check
 *  instead of at the branch that should have rejected it. `blob:` and `data:`
 *  are deliberately absent: those address memory in this webview, and there is
 *  nothing for another application to open. */
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

/** Open `url` in whatever the host uses for it — the system browser under
 *  Tauri, a new tab in a browser build. Rejects rather than reporting: the
 *  caller decides how a failure is surfaced. */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  // Imported lazily, as every other Tauri-only package in this app is, so the
  // browser bundle never pulls it in.
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/** `openExternal`, with the failure reported rather than dropped. A link that
 *  does nothing when clicked is the defect this module exists to remove, and a
 *  silently discarded rejection would put it straight back — under a different
 *  cause (a missing capability, an unhandled scheme) and with no way to tell. */
export function openExternalReported(url: string): void {
  void openExternal(url).catch((err: unknown) => {
    toast.error("Couldn't open the link", {
      description: err instanceof Error ? err.message : String(err),
    });
  });
}

/** Whether a click on this anchor should leave the app. True for another
 *  origin — the runner, an app's own port, the docs — and for the scheme-only
 *  addresses that have no origin to compare. An anchor pointing back at the
 *  editor's own origin is in-app navigation and is left alone, which is what
 *  keeps the dev server's own URLs from being handed to a browser. */
export function isExternalHref(href: string, pageOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(href, pageOrigin);
  } catch {
    return false;
  }
  if (!EXTERNAL_SCHEMES.has(url.protocol)) return false;
  if (url.protocol === "mailto:" || url.protocol === "tel:") return true;
  return url.origin !== pageOrigin;
}

/** The anchor a click should open externally, or null. Exported for the tests:
 *  every reason to decline is a separate rule and each one is a real click
 *  somebody makes. */
export function externalAnchorFor(event: MouseEvent): HTMLAnchorElement | null {
  // Someone already handled it, or the user asked their own browser for a new
  // tab / window / download — leave all of that to the platform.
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;

  const target = event.target;
  const anchor = target instanceof Element ? target.closest("a") : null;
  if (!anchor || !anchor.href) return null;
  // A save link (debug-ui's payload download) writes a file; it is not a place
  // to visit, and handing its blob: URL to another application opens nothing.
  if (anchor.hasAttribute("download")) return null;
  return isExternalHref(anchor.href, window.location.origin) ? anchor : null;
}

/**
 * Route external link clicks to the host. Returns a teardown.
 *
 * Installed only under Tauri: in a browser the anchors already work, and
 * intercepting them would replace correct native behaviour with a worse copy of
 * it. Listens on the capture phase so it sees a click before a component's own
 * handler can stop it, and re-checks `defaultPrevented` so one that genuinely
 * owns the click still wins.
 */
export function installExternalLinkHandler(): () => void {
  if (!isTauri()) return () => undefined;

  const onClick = (event: MouseEvent): void => {
    const anchor = externalAnchorFor(event);
    if (!anchor) return;
    event.preventDefault();
    openExternalReported(anchor.href);
  };

  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}
