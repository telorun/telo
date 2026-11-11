import { LOCAL_PREFIXES } from "../storage-keys";

/** Whether the user chose "Always open this app" for an app of a workspace —
 *  asked once per (workspace, app name), and only ever for a `port` request. */

function keyFor(workspaceKey: string, app: string): string {
  return `${LOCAL_PREFIXES.openApp}${encodeURIComponent(workspaceKey)}:${encodeURIComponent(app)}`;
}

/** A stored value that is not the expected one is reported and treated as no
 *  answer; it is left in place, never rewritten as a choice. */
export function isAlwaysOpen(workspaceKey: string, app: string): boolean {
  const key = keyFor(workspaceKey, app);
  const raw = localStorage.getItem(key);
  if (raw === null) return false;
  try {
    const value = JSON.parse(raw) as { always?: unknown };
    if (value !== null && typeof value === "object" && value.always === true) return true;
  } catch {
    // reported below with the rest of the unreadable cases
  }
  console.warn(`Ignoring an unreadable "always open" answer stored at ${key}.`);
  return false;
}

export function setAlwaysOpen(workspaceKey: string, app: string): void {
  localStorage.setItem(keyFor(workspaceKey, app), JSON.stringify({ always: true }));
}

export function forgetAlwaysOpen(workspaceKey: string, app: string): void {
  localStorage.removeItem(keyFor(workspaceKey, app));
}
