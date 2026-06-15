import * as http from "http";
import * as fsp from "fs/promises";
import type { AppEndpoint } from "@telorun/debug-ui";
import { LruBlobStore } from "./blob-store.js";

/** The debug wire protocol this server speaks, advertised at `/json/version` so a
 *  consumer can refuse a mismatch. The wire format (`wire-schema.json`) is v1. */
const PROTOCOL = "telo-debug";
const PROTOCOL_VERSION = 1;

export interface DebugServerOptions {
  /** Preferred bind host. Default `127.0.0.1` (loopback). */
  host?: string;
  /** Preferred port; falls back to an ephemeral port if taken. Default 9230. */
  port?: number;
  /** Path to the JSONL file, served at `/events.jsonl` for download. */
  jsonlPath?: string;
  /** Absolute path to the single-file debug UI (`resolveUiBundle`). When absent,
   *  the endpoint runs headless and `/` returns a "UI not available" notice. */
  uiHtmlPath?: string;
  /** Why the UI bundle is absent — rendered verbatim in the `/` 503 (e.g. the
   *  exact fetch URL that failed) so the failure is explicit, not generic. */
  uiUnavailableReason?: string;
  /** Replay ring-buffer size. Default 5000. */
  bufferSize?: number;
}

/**
 * Localhost-only HTTP server that serves the debug-watcher UI and streams events
 * to it over SSE. Bound to `127.0.0.1` because events can carry secrets. The
 * caller pushes already-serialized wire lines via {@link push}; the server keeps
 * a bounded replay buffer so a browser opened (or reconnected) mid-run sees
 * history, then live events.
 *
 * Producer-side and Node-specific by design — a Rust/Go kernel reimplements this;
 * the cross-runtime contract is the wire format and these endpoints, not the code.
 */
export class DebugServer {
  private readonly server: http.Server;
  private readonly clients = new Set<http.ServerResponse>();
  private readonly heartbeats = new Set<ReturnType<typeof setInterval>>();
  private readonly buffer: string[] = [];
  private readonly bufferSize: number;
  private readonly host: string;
  private _url = "";
  private _endpoints: AppEndpoint[] = [];

  /** Binary payloads are offloaded here and served at `/blobs/:id`; the serializer
   *  emits pointers into the event log. */
  readonly blobStore = new LruBlobStore();

  constructor(private readonly options: DebugServerOptions = {}) {
    this.bufferSize = options.bufferSize ?? 5000;
    this.host = options.host ?? "127.0.0.1";
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  get url(): string {
    return this._url;
  }

  /** Advertise where the running app is reachable; the UI fetches these from the
   *  `/json/version` handshake and renders them as links. Hosts are left blank —
   *  the producer can't know which hostname the viewer used, so the UI fills them
   *  from its own origin. Updatable across watch reloads. */
  setEndpoints(endpoints: AppEndpoint[]): void {
    this._endpoints = endpoints;
  }

  /** Start listening on the configured host (loopback by default). Resolves once
   *  the URL is known. */
  async start(): Promise<void> {
    const preferred = this.options.port ?? 9230;
    const port = await this.listen(preferred).catch(() => this.listen(0));
    // A non-loopback bind is reachable as-is; loopback is friendlier as localhost.
    const displayHost =
      this.host === "127.0.0.1" || this.host === "::1" || this.host === "0.0.0.0"
        ? "localhost"
        : this.host;
    this._url = `http://${displayHost}:${port}`;
  }

  private listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: unknown) => {
        this.server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.removeListener("error", onError);
        const addr = this.server.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(port, this.host);
      // Never keep the process alive on the debug server's account: a one-shot
      // `telo run --debug` still exits when its work is done; the UI is live only
      // while the app itself keeps running (the watch-the-events use case).
      this.server.unref();
    });
  }

  /** Fan one serialized wire line to the replay buffer and every live client. */
  push(line: string): void {
    this.buffer.push(line);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.splice(0, this.buffer.length - this.bufferSize);
    }
    const frame = `data: ${line}\n\n`;
    for (const res of this.clients) res.write(frame);
  }

  /**
   * Tear down so nothing keeps the process alive. `unref` alone is unreliable
   * across runtimes (bun ignores `socket.unref()`), so we *actively* clear every
   * heartbeat timer and destroy every live SSE socket, then close the listener.
   * Synchronous and idempotent — safe to call from a signal handler.
   */
  stop(): void {
    for (const hb of this.heartbeats) clearInterval(hb);
    this.heartbeats.clear();
    for (const res of this.clients) {
      try {
        res.destroy();
      } catch {
        /* already gone */
      }
      try {
        res.socket?.destroy();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
    try {
      this.server.close();
    } catch {
      /* not listening */
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/events") return this.handleSse(res);
    if (url.pathname === "/events.jsonl") return void this.handleJsonl(res);
    if (url.pathname.startsWith("/blobs/")) {
      return this.handleBlob(decodeURIComponent(url.pathname.slice("/blobs/".length)), res);
    }
    if (url.pathname === "/json/version") return this.handleVersion(res);
    return void this.handleUi(res);
  }

  /** Discovery handshake: protocol identity + version + endpoint paths, so a
   *  consumer can confirm it speaks this server's wire format before connecting. */
  private handleVersion(res: http.ServerResponse): void {
    res
      .writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      })
      .end(
        JSON.stringify({
          protocol: PROTOCOL,
          protocolVersion: PROTOCOL_VERSION,
          url: this._url,
          events: "/events",
          eventsLog: "/events.jsonl",
          blobs: "/blobs/",
          appEndpoints: this._endpoints,
        }),
      );
  }

  private handleSse(res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // The server is loopback-bound (the real boundary); CORS only governs
      // which browser origins may read it. `*` lets an embedding webview (the
      // editor's debug panel) consume the stream cross-origin.
      "Access-Control-Allow-Origin": "*",
    });
    // Replay history, then stream live.
    for (const line of this.buffer) res.write(`data: ${line}\n\n`);
    this.clients.add(res);
    // The debug server must never keep the CLI alive. The listening socket is
    // unref'd in listen(), but an established SSE connection — and its heartbeat
    // timer — are separately ref'd; without unref'ing them, Ctrl+C hangs while a
    // browser is watching. Unref'd handles still work while the app keeps the
    // loop alive; they just stop being a reason *not* to exit.
    res.socket?.unref();
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    heartbeat.unref?.();
    this.heartbeats.add(heartbeat);
    res.on("close", () => {
      clearInterval(heartbeat);
      this.heartbeats.delete(heartbeat);
      this.clients.delete(res);
    });
  }

  private handleBlob(id: string, res: http.ServerResponse): void {
    const blob = this.blobStore.get(id);
    if (!blob) {
      res.writeHead(404).end("blob not found");
      return;
    }
    res
      .writeHead(200, {
        "Content-Type": blob.mediaType,
        "Cache-Control": "no-store",
        "Content-Length": String(blob.bytes.byteLength),
        "Access-Control-Allow-Origin": "*",
      })
      .end(blob.bytes);
  }

  private async handleJsonl(res: http.ServerResponse): Promise<void> {
    if (!this.options.jsonlPath) {
      res.writeHead(404).end("no event log");
      return;
    }
    try {
      const body = await fsp.readFile(this.options.jsonlPath);
      res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" }).end(body);
    } catch {
      res.writeHead(404).end("event log not found");
    }
  }

  /** Serve the single-file UI for every non-API path. The bundle is fully
   *  self-contained (JS + CSS inlined), so there are no asset routes to resolve
   *  and no path-traversal surface. Absent bundle → a 503 notice; the endpoint
   *  itself (SSE / JSONL / blobs / version) keeps working headless. */
  private async handleUi(res: http.ServerResponse): Promise<void> {
    if (!this.options.uiHtmlPath) {
      const detail = this.options.uiUnavailableReason ?? "the UI bundle could not be resolved or fetched.";
      res
        .writeHead(503, { "Content-Type": "text/html; charset=utf-8" })
        .end(
          "<h1>Debug UI not available</h1><p>The endpoint is live at <code>/events</code>; " +
            `${escapeHtml(detail)}</p>`,
        );
      return;
    }
    try {
      const body = await fsp.readFile(this.options.uiHtmlPath);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  }
}

/** Minimal HTML-text escape for interpolating a diagnostic (which may contain a
 *  URL) into the 503 body without opening an injection hole. */
function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );
}
