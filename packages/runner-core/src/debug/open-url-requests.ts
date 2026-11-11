import { isEventFrame, type DebugFrame } from "@telorun/debug-wire";

import type { OpenUrlReach } from "../contract.js";

/** The kernel says this once per `Telo.OpenUrl` call. */
export const OPEN_URL_REQUESTED_EVENT = "Kernel.OpenUrlRequested";

/** The longest URL text accepted, in bytes. */
export const OPEN_URL_MAX_BYTES = 8 * 1024;

/** Most distinct requests published per app generation. */
export const OPEN_URL_MAX_PER_GENERATION = 16;

export interface OpenUrlRequest {
  url: string;
  reach: OpenUrlReach;
  port?: number;
}

/** What the session routes: the tcp ports each app declares, by app. */
export interface RoutedPorts {
  /** The tcp ports of every app of the session, as currently declared. */
  declared(): Array<{ app: string; ports: number[] }>;
}

/**
 * Turns `Kernel.OpenUrlRequested` frames into the requests a client may act on.
 *
 * The frame comes from the workload, which is untrusted: it can say anything,
 * so only an absolute http(s) URL without credentials passes, it is
 * re-serialized here, and a payload that is not that shape is ignored rather
 * than failing the relay. Per (app, generation) a URL is published once and at
 * most {@link OPEN_URL_MAX_PER_GENERATION} are; the state is one set per app,
 * replaced when the app's generation changes.
 */
export class OpenUrlRequests {
  private readonly seen = new Map<string, { generation: number; urls: Set<string> }>();
  /** Ports whose routing was refused, per app, until the app routes them. */
  private readonly rejected = new Map<string, Set<number>>();

  /** Record a routing verdict from an `endpoints` change. */
  routing(app: string, change: { added?: Array<{ port: number }>; rejected?: Array<{ port: number }> }): void {
    const refused = this.rejected.get(app) ?? new Set<number>();
    for (const { port } of change.rejected ?? []) refused.add(port);
    for (const { port } of change.added ?? []) refused.delete(port);
    if (refused.size > 0) this.rejected.set(app, refused);
    else this.rejected.delete(app);
  }

  /** The request a frame stands for, or undefined when there is none to publish. */
  request(
    app: string,
    generation: number,
    frame: DebugFrame,
    routed: RoutedPorts,
  ): OpenUrlRequest | undefined {
    if (!isEventFrame(frame) || frame.event !== OPEN_URL_REQUESTED_EVENT) return undefined;
    const raw = (frame.payload as { url?: unknown } | undefined)?.url;
    const url = parseOpenUrl(raw);
    if (!url) return undefined;

    const classified = this.classify(url, routed);
    let state = this.seen.get(app);
    if (!state || state.generation !== generation) {
      state = { generation, urls: new Set() };
      this.seen.set(app, state);
    }
    if (state.urls.has(url.href) || state.urls.size >= OPEN_URL_MAX_PER_GENERATION) return undefined;
    state.urls.add(url.href);
    return { url: url.href, ...classified };
  }

  /** An app left the session. */
  forget(app: string): void {
    this.seen.delete(app);
    this.rejected.delete(app);
  }

  private classify(url: URL, routed: RoutedPorts): { reach: OpenUrlReach; port?: number } {
    if (!isLoopbackHost(url.hostname)) return { reach: "external" };
    const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    const isRouted = routed
      .declared()
      .some(({ app, ports }) => ports.includes(port) && !this.rejected.get(app)?.has(port));
    return { reach: isRouted ? "port" : "unrouted", port };
  }
}

function parseOpenUrl(raw: unknown): URL | undefined {
  if (typeof raw !== "string" || raw.length > OPEN_URL_MAX_BYTES) return undefined;
  if (new TextEncoder().encode(raw).length > OPEN_URL_MAX_BYTES) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not an absolute URL: the verdict is "nothing to open".
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  // The event carries `href`, which percent-encodes non-ASCII, so it is bounded itself.
  if (url.href.length > OPEN_URL_MAX_BYTES) return undefined;
  return url;
}

/** `localhost`, `*.localhost`, 127.0.0.0/8, `[::1]` and the unspecified
 *  addresses, on the WHATWG-normalized host. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host === "[::]"
  );
}
