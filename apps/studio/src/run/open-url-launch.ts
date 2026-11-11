import { isTauri } from "@tauri-apps/api/core";

import { openExternal } from "../external-link";

/**
 * Open `url` with no user gesture behind it. False when a browser blocked it,
 * so the caller can ask instead; Tauri's opener is not blocked. The tab is
 * opened without `noopener` only so the browser reports a block (`noopener`
 * always answers null), and the opener link is cut at once.
 */
export async function openWithoutGesture(url: string): Promise<boolean> {
  if (isTauri()) {
    await openExternal(url);
    return true;
  }
  const opened = window.open(url, "_blank");
  if (!opened) return false;
  opened.opener = null;
  return true;
}
