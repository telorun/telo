import { SEVERITY, type ResourceContext, type ResourceManifest, type TextRecord } from "@telorun/sdk";
import { runAction, type Action } from "./action.js";
import { acquireHost, type HostLease } from "./host-session.js";
import { shownText } from "./texts.js";

type MenuEntry =
  | { type: "item"; label: TextRecord; action?: Action; enabled?: boolean }
  | { type: "separator" };

interface TrayResource extends ResourceManifest {
  host: unknown;
  icon: unknown;
  monochrome?: boolean;
  tooltip?: TextRecord;
  action?: Action;
  menu?: MenuEntry[];
}

class TrayIcon {
  constructor(
    private readonly resource: TrayResource,
    private readonly ctx: ResourceContext,
  ) {}

  private get name(): string {
    return this.resource.metadata.name;
  }

  run() {
    let lease: HostLease;
    let releaseHold: (() => void) | undefined;
    return this.ctx
      .effect("host connection", async () => {
        lease = await acquireHost(this.ctx, "/host");
        return { result: undefined, inverse: () => lease.release() };
      })
      .effect("tray icon", async () => {
        const { connection } = lease;
        const menu = this.resource.menu ?? [];
        const offTray = connection.on("Tray.ItemChosen", (payload) => {
          const entry = payload.tray === this.name ? menu[payload.item] : undefined;
          if (entry?.type === "item" && entry.action) {
            void runAction(this.ctx, entry.action, `${this.name} menu item ${payload.item}`);
          }
        });
        const offClick = connection.on("Tray.Clicked", (payload) => {
          if (payload.tray === this.name && this.resource.action) {
            void runAction(this.ctx, this.resource.action, `${this.name} click`);
          }
        });
        let offEnd: (() => void) | undefined;
        let available: boolean;
        try {
          ({ available } = await connection.request("Tray.Open", this.openPayload()));
        } catch (err) {
          offTray();
          offClick();
          throw err;
        }
        if (!available) {
          this.ctx.log.log(
            SEVERITY.warn,
            `Desktop.TrayIcon/${this.name}: this session has no tray, so no icon is shown (DESKTOP_TRAY_UNAVAILABLE)`,
            undefined,
            { eventName: "DESKTOP_TRAY_UNAVAILABLE" },
          );
        } else {
          releaseHold = this.ctx.acquireHold(`desktop tray ${this.name}`);
          offEnd = connection.onEnd(() => releaseHold?.());
        }
        return {
          result: undefined,
          inverse: async () => {
            offTray();
            offClick();
            offEnd?.();
            releaseHold?.();
            if (!connection.closed) await connection.request("Tray.Close", { tray: this.name });
          },
        };
      });
  }

  private openPayload(): Record<string, unknown> {
    const r = this.resource;
    const payload: Record<string, unknown> = {
      icon: String(r.icon),
      menu: (r.menu ?? []).map((entry, index) =>
        entry.type === "separator"
          ? { type: "separator" }
          : { enabled: entry.enabled ?? true, item: index, label: shownText(this.ctx, entry.label), type: "item" },
      ),
      monochrome: r.monochrome ?? false,
      tray: this.name,
    };
    if (r.tooltip !== undefined) payload.tooltip = shownText(this.ctx, r.tooltip);
    return payload;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export const Tray = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: TrayResource, ctx: ResourceContext) {
    return new TrayIcon(resource, ctx);
  },
};
