// A relay for the client engine's tests: a WebSocket server on loopback that
// either replays raw channel steps or speaks the tunnel's HTTP/2 as the client.

import http from "node:http";
import http2, { type ClientHttp2Session, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";

import { WebSocket, WebSocketServer } from "ws";

import { TUNNEL_SUBPROTOCOL } from "../../src/index.js";
import { WebSocketDuplex } from "../../src/websocket-duplex.js";

export type RelayMessage =
  | { kind: "text"; text: string }
  | { kind: "binary"; data: Buffer }
  | { kind: "close"; code: number; reason: string };

export interface FakeRelayOptions {
  /** The subprotocol the upgrade selects; `null` selects none. Default `telo-share-1`. */
  subprotocol?: string | null;
  /** Answer every upgrade with this HTTP status instead. */
  status?: number;
}

export class FakeRelay {
  readonly connections: RelayConnection[] = [];
  /** Upgrade requests received, answered or not. */
  attempts = 0;
  private readonly waiting: Array<(connection: RelayConnection) => void> = [];

  private constructor(
    private readonly server: http.Server,
    private readonly wss: WebSocketServer,
    readonly tunnelUrl: string,
  ) {}

  static async start(options: FakeRelayOptions = {}): Promise<FakeRelay> {
    const subprotocol = options.subprotocol === undefined ? TUNNEL_SUBPROTOCOL : options.subprotocol;
    const wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: 0,
      handleProtocols: () => (subprotocol === null ? false : subprotocol),
    });
    const server = http.createServer((req, res) => res.writeHead(404).end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const relay = new FakeRelay(server, wss, `ws://127.0.0.1:${port}/v1/shares/k3xqz2m7ahc4/tunnel`);
    server.on("upgrade", (request, socket, head) => {
      relay.attempts++;
      if (options.status !== undefined) {
        socket.end(`HTTP/1.1 ${options.status} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => relay.accept(new RelayConnection(ws, request)));
    });
    return relay;
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private taken = 0;

  /** The client's next connection, in order. */
  nextConnection(timeoutMs = 5_000): Promise<RelayConnection> {
    const next = this.connections[this.taken];
    if (next !== undefined) {
      this.taken++;
      return Promise.resolve(next);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no connection within ${timeoutMs} ms`)), timeoutMs);
      this.waiting.push((connection) => {
        clearTimeout(timer);
        resolve(connection);
      });
    });
  }

  private accept(connection: RelayConnection): void {
    this.connections.push(connection);
    const waiter = this.waiting.shift();
    if (waiter !== undefined) {
      this.taken++;
      waiter(connection);
    }
  }
}

export interface RelayResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export class RelayConnection {
  /** The largest binary message the client sent. */
  largestBinary = 0;
  readonly closed: Promise<{ code: number; reason: string }>;

  private readonly messages: RelayMessage[] = [];
  private readonly waiters: Array<() => void> = [];
  private duplex: WebSocketDuplex | undefined;
  private session: ClientHttp2Session | undefined;

  constructor(
    readonly ws: WebSocket,
    readonly request: http.IncomingMessage,
  ) {
    ws.on("message", (data, isBinary) => {
      const bytes = data as Buffer;
      if (isBinary) {
        this.largestBinary = Math.max(this.largestBinary, bytes.length);
        if (this.duplex !== undefined) {
          this.duplex.receive(bytes);
          return;
        }
        this.push({ kind: "binary", data: bytes });
      } else {
        this.push({ kind: "text", text: bytes.toString("utf8") });
      }
    });
    this.closed = new Promise((resolve) => {
      ws.on("close", (code, reason) => {
        this.duplex?.receiveEnd();
        this.push({ kind: "close", code, reason: reason.toString() });
        resolve({ code, reason: reason.toString() });
      });
    });
    ws.on("error", () => ws.terminate());
  }

  /** The client's next message, in order. */
  async next(timeoutMs = 5_000): Promise<RelayMessage> {
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

  /** What the client sent that nothing has taken yet. */
  queued(): readonly RelayMessage[] {
    return this.messages;
  }

  /** The client's next text message as JSON, skipping binary ones. */
  async nextControl(timeoutMs = 5_000): Promise<Record<string, unknown>> {
    for (;;) {
      const message = await this.next(timeoutMs);
      if (message.kind === "text") return JSON.parse(message.text) as Record<string, unknown>;
      if (message.kind === "close") throw new Error(`closed ${message.code} ${message.reason}`);
    }
  }

  sendControl(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  close(code: number, reason = ""): void {
    this.ws.close(code, reason);
  }

  /** Answers the client's hello with `epoch` and starts HTTP/2 as the relay does. */
  async handshake(epoch: number): Promise<Record<string, unknown>> {
    const hello = await this.nextControl();
    this.sendControl({ type: "hello", epoch });
    this.duplex = new WebSocketDuplex(this.ws);
    for (const message of this.messages.splice(0)) {
      if (message.kind === "binary") this.duplex.receive(message.data);
      else this.messages.push(message);
    }
    const session = http2.connect("http://share.test", { createConnection: () => this.duplex! });
    session.on("error", () => session.destroy());
    this.session = session;
    await new Promise<void>((resolve) => session.once("remoteSettings", () => resolve()));
    return hello;
  }

  /** One visitor request through the tunnel. */
  async fetch(headers: OutgoingHttpHeaders, body?: Buffer | string): Promise<RelayResponse> {
    const stream = this.h2().request({ ":method": "GET", ":path": "/", ":scheme": "https", ...headers });
    const chunks: Buffer[] = [];
    let responseHeaders: IncomingHttpHeaders | undefined;
    stream.on("response", (received) => (responseHeaders = received));
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.end(body);
    await new Promise<void>((resolve, reject) => {
      stream.once("end", resolve);
      stream.once("error", reject);
      stream.once("close", () => {
        if (stream.rstCode !== http2.constants.NGHTTP2_NO_ERROR) reject(new Error(`reset ${stream.rstCode}`));
      });
    });
    if (responseHeaders === undefined) throw new Error("ended with no response");
    return { status: Number(responseHeaders[":status"]), headers: responseHeaders, body: Buffer.concat(chunks) };
  }

  /** Opens an extended CONNECT stream, as a visitor's WebSocket arrives. */
  connect(headers: OutgoingHttpHeaders): http2.ClientHttp2Stream {
    return this.h2().request({ ":method": "CONNECT", ":protocol": "websocket", ":scheme": "https", ":path": "/", ...headers });
  }

  private h2(): ClientHttp2Session {
    if (this.session === undefined) throw new Error("handshake() first");
    return this.session;
  }

  private push(message: RelayMessage): void {
    this.messages.push(message);
    for (const waiter of this.waiters.splice(0)) waiter();
  }
}
