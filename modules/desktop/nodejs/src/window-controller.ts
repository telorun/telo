import type { ResourceContext, ResourceManifest, TextRecord } from "@telorun/sdk";
import { acquireHost, type HostLease } from "./host-session.js";
import { shownText } from "./texts.js";

interface Size {
  width: number;
  height: number;
}

interface WindowResource extends ResourceManifest {
  host: unknown;
  path?: string;
  title?: TextRecord;
  size?: Size;
  minSize?: Size;
  resizable?: boolean;
  visible?: boolean;
  onClose?: "close" | "hide";
}

export class DesktopWindow {
  constructor(
    private readonly resource: WindowResource,
    private readonly ctx: ResourceContext,
  ) {}

  private get name(): string {
    return this.resource.metadata.name;
  }

  /** Shows and focuses the window, for `Desktop.ShowWindow`. */
  async show(): Promise<void> {
    const lease = await acquireHost(this.ctx, "/host");
    try {
      await lease.connection.request("Window.Show", { window: this.name });
    } finally {
      lease.release();
    }
  }

  run() {
    let lease: HostLease;
    let releaseHold: (() => void) | undefined;
    // The user may close the window before the hold below is taken; then none is taken.
    let closed = false;
    return this.ctx
      .effect("host connection", async () => {
        lease = await acquireHost(this.ctx, "/host");
        return { result: undefined, inverse: () => lease.release() };
      })
      .effect("window", async () => {
        const { connection } = lease;
        const unsubscribe = connection.on("Window.Closed", (payload) => {
          if (payload.window === this.name) {
            closed = true;
            releaseHold?.();
            releaseHold = undefined;
          }
        });
        try {
          await connection.request("Window.Open", this.openPayload());
        } catch (err) {
          unsubscribe();
          throw err;
        }
        return {
          result: undefined,
          inverse: async () => {
            unsubscribe();
            if (!connection.closed) await connection.request("Window.Close", { window: this.name });
          },
        };
      })
      .effect("kernel hold", async () => {
        if (!closed) releaseHold = this.ctx.acquireHold(`desktop window ${this.name}`);
        // A host that is gone shows no window, so nothing is left to keep the application for.
        const offEnd = lease.connection.onEnd(() => releaseHold?.());
        return {
          result: undefined,
          inverse: () => {
            offEnd();
            releaseHold?.();
          },
        };
      });
  }

  private openPayload(): Record<string, unknown> {
    const r = this.resource;
    const payload: Record<string, unknown> = {
      onClose: r.onClose ?? "close",
      path: r.path ?? "/",
      resizable: r.resizable ?? true,
      visible: r.visible ?? true,
      window: this.name,
    };
    if (r.title !== undefined) payload.title = shownText(this.ctx, r.title);
    if (r.size !== undefined) payload.size = { height: r.size.height, width: r.size.width };
    if (r.minSize !== undefined) payload.minSize = { height: r.minSize.height, width: r.minSize.width };
    return payload;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export const Window = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: WindowResource, ctx: ResourceContext) {
    return new DesktopWindow(resource, ctx);
  },
};
