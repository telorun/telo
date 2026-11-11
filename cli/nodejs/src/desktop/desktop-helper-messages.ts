/**
 * The message set of the link to `telo-desktop-host` (`cli/rust/desktop-host/README.md`):
 * the host-to-helper requests as typed payloads and the helper-to-host
 * notifications, each read as a CLOSED object — a member the table does not
 * list is a violation, as it is on the helper's side.
 */

export interface Size {
  width: number;
  height: number;
}

export interface HelperInit {
  identifier: string;
  productName: string;
  /** The app's origin, `http://127.0.0.1:<port>`. */
  origin: string;
  /** The host's own pages, `http://127.0.0.1:<another port>`; a window loads both origins. */
  hostOrigin: string;
  /** Absolute; the webview data store on Windows and Linux. */
  webviewDirectory: string;
  showInDock: boolean;
  /** Absolute path of a PNG: the window icon on Windows and Linux. */
  icon?: string;
}

export interface WindowOpen {
  window: string;
  /** `<host origin>/admit?code=<code>`: the window's single-use admission. */
  url: string;
  title?: string;
  size?: Size;
  minSize?: Size;
  resizable: boolean;
  visible: boolean;
  onClose: "close" | "hide";
}

export type TrayMenuEntry =
  | { type: "item"; item: number; label: string; enabled: boolean }
  | { type: "separator" };

export interface TrayOpen {
  tray: string;
  icon: string;
  monochrome: boolean;
  tooltip?: string;
  /** An item's `item` is its index in the whole list, separators counted. */
  menu: TrayMenuEntry[];
}

/** Every notification the helper sends, by type. */
export interface HelperNotifications {
  "Helper.QuitRequested": Record<string, never>;
  "Helper.Reopened": Record<string, never>;
  "Window.Closed": { window: string };
  "Window.Hidden": { window: string };
  "Window.OpenRequested": { fromWindow: string; url: string };
  "Navigation.External": { window: string; url: string };
  "Tray.ItemChosen": { tray: string; item: number };
  "Tray.Clicked": { tray: string };
}

export type NotificationType = keyof HelperNotifications;

type MemberType = "string" | "count" | "boolean";

const NOTIFICATION_MEMBERS: Record<NotificationType, Record<string, MemberType>> = {
  "Helper.QuitRequested": {},
  "Helper.Reopened": {},
  "Window.Closed": { window: "string" },
  "Window.Hidden": { window: "string" },
  "Window.OpenRequested": { fromWindow: "string", url: "string" },
  "Navigation.External": { window: "string", url: "string" },
  "Tray.ItemChosen": { tray: "string", item: "count" },
  "Tray.Clicked": { tray: "string" },
};

export function isNotificationType(type: string): type is NotificationType {
  return Object.hasOwn(NOTIFICATION_MEMBERS, type);
}

/** Why `payload` is not what `type`'s table lists, or `undefined` when it is. */
export function notificationFault(type: NotificationType, payload: unknown): string | undefined {
  return closedObjectFault(payload, NOTIFICATION_MEMBERS[type]);
}

export function readyFault(payload: unknown): string | undefined {
  return closedObjectFault(payload, { version: "string", tray: "boolean" });
}

export function unavailableFault(payload: unknown): string | undefined {
  return closedObjectFault(payload, { reason: "string" });
}

function closedObjectFault(payload: unknown, members: Record<string, MemberType>): string | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return "a payload that is not an object";
  const record = payload as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(members, key)) return `a member '${key}' its table does not list`;
  }
  for (const [key, type] of Object.entries(members)) {
    const value = record[key];
    if (value === undefined) return `no member '${key}'`;
    const ok =
      type === "string" ? typeof value === "string"
      : type === "boolean" ? typeof value === "boolean"
      : typeof value === "number" && Number.isInteger(value) && value >= 0;
    if (!ok) return `a member '${key}' of the wrong type`;
  }
  return undefined;
}
