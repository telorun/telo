// A relay on loopback for tests, over a memory share store and a SQLite store
// recording proof `jti`s; a visitor's HTTP client; and a raw tunnel driver that
// plays the client's side of the channel step by step.

import http from "node:http";
import type { AddressInfo } from "node:net";

import { TUNNEL_SUBPROTOCOL } from "@telorun/share-tunnel";
import { WebSocket } from "ws";

import type { ShareRouting } from "../backend.js";
import type { SharesConfig } from "../config.js";
import { buildRelayServer, type RelayHandle } from "../relay/relay-server.js";
import type { ShareRelayTimings } from "../relay/relay-tunnel.js";
import type { SessionStore } from "../session-store/session-store.js";
import type { ShareStore } from "../session-store/share-store.js";
import { testConfig } from "./fake-workload-backend.js";
import { withShares } from "./memory-share-store.js";
import { TEST_IDENTITY, type TestIssuer } from "./test-identity.js";

export const SHARE_BASE_DOMAIN = "share.test";

export interface RelayOptions {
  issuer: TestIssuer;
  /** The share half of the store. */
  shares: ShareStore;
  /** The session half, which records proof `jti`s. */
  jti: SessionStore;
  /** Listen here, as a restarted relay does; else any free port. */
  port?: number;
  settings?: Partial<SharesConfig>;
  timings?: Partial<ShareRelayTimings>;
}

export interface RelayUnderTest {
  handle: RelayHandle;
  port: number;
  tunnelUrl(shareId: string): string;
  /** The `Host` of `port` on the share. */
  visitorHost(shareId: string, port: number, label?: string): string;
  close(): Promise<void>;
}

export async function startRelay(options: RelayOptions): Promise<RelayUnderTest> {
  let port = options.port ?? 0;
  const routing: ShareRouting = {
    addresses: (id) => ({
      publicUrlTemplate: `https://{port}-${id}.${SHARE_BASE_DOMAIN}`,
      publicUrlSecondaryTemplate: `https://{label}--{port}-${id}.${SHARE_BASE_DOMAIN}`,
      tunnelUrl: `ws://127.0.0.1:${port}/v1/shares/${id}/tunnel`,
    }),
    baseDomain: SHARE_BASE_DOMAIN,
  };
  const config = testConfig({
    identity: TEST_IDENTITY,
    shares: { ...testConfig().shares, enabled: true, role: "relay", ...options.settings },
  });
  const handle = await buildRelayServer({
    shareRouting: routing,
    config,
    store: withShares(options.jti, options.shares),
    fetch: options.issuer.fetch,
    timings: { closeGraceMs: 200, ...options.timings },
  });
  await handle.app.listen({ port, host: "127.0.0.1" });
  port = (handle.app.server.address() as AddressInfo).port;
  return {
    handle,
    port,
    tunnelUrl: (id) => routing.addresses(id).tunnelUrl,
    visitorHost: (id, sharedPort, label) => `${label ? `${label}--` : ""}${sharedPort}-${id}.${SHARE_BASE_DOMAIN}`,
    close: () => handle.app.close(),
  };
}

export interface VisitorResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** One visitor request to the relay at `port`, for `host`. */
export function visit(
  port: number,
  host: string,
  options: { method?: string; path?: string; headers?: http.OutgoingHttpHeaders; body?: Buffer | string } = {},
): Promise<VisitorResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers: { ...options.headers, host },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}

export type DriverMessage =
  | { kind: "text"; text: string }
  | { kind: "binary"; data: Buffer }
  | { kind: "close"; code: number; reason: string };

/** The client's side of one tunnel, played by hand. */
export class TunnelDriver {
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly messages: DriverMessage[] = [];
  private readonly waiters: Array<() => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data, isBinary) => {
      const bytes = data as Buffer;
      this.push(isBinary ? { kind: "binary", data: bytes } : { kind: "text", text: bytes.toString("utf8") });
    });
    this.closed = new Promise((resolve) => {
      ws.on("close", (code, reason) => {
        this.push({ kind: "close", code, reason: reason.toString() });
        resolve({ code, reason: reason.toString() });
      });
    });
    ws.on("error", () => ws.terminate());
  }

  /** Opens the tunnel with `headers` (the upgrade's `Authorization` and `DPoP`). */
  static open(url: string, headers: Record<string, string>): Promise<TunnelDriver> {
    const ws = new WebSocket(url, [TUNNEL_SUBPROTOCOL], { headers, perMessageDeflate: false, maxPayload: 0 });
    const driver = new TunnelDriver(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(driver));
      ws.once("unexpected-response", (req, res) => reject(new Error(`upgrade answered ${res.statusCode}`)));
      ws.once("error", reject);
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  /** The relay's next message, in order. */
  async next(timeoutMs = 5_000): Promise<DriverMessage> {
    const deadline = Date.now() + timeoutMs;
    while (this.messages.length === 0) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no message within ${timeoutMs} ms`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.messages.shift()!;
  }

  /** Takes every binary message at the head of the queue. */
  takeBinaries(): void {
    while (this.messages[0]?.kind === "binary") this.messages.shift();
  }

  queued(): readonly DriverMessage[] {
    return this.messages;
  }

  /** The relay's next close, skipping binary messages; a text message fails. */
  async nextClose(timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
    for (;;) {
      const message = await this.next(timeoutMs);
      if (message.kind === "binary") continue;
      if (message.kind === "text") throw new Error(`expected a close, got ${message.text}`);
      return message;
    }
  }

  private push(message: DriverMessage): void {
    this.messages.push(message);
    for (const waiter of this.waiters.splice(0)) waiter();
  }
}

/** Counts every call on `store`. */
export function countingShareStore(store: ShareStore): { store: ShareStore; calls: string[] } {
  const calls: string[] = [];
  const counted = new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(key));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store: counted, calls };
}
