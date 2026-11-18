// One visitor request carried to the shared run as a stream of the tunnel's
// HTTP/2 connection: a request as a request, a WebSocket upgrade as an RFC 8441
// extended CONNECT whose bytes are then piped both ways.

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { STATUS_CODES } from "node:http";
import {
  constants,
  type ClientHttp2Stream,
  type IncomingHttpHeaders,
  type IncomingHttpStatusHeader,
  type OutgoingHttpHeaders,
} from "node:http2";
import type { Duplex } from "node:stream";

import { SHARE_PORT_HEADER } from "@telorun/share-tunnel";

/** Opens one stream on a share's tunnel; `undefined` when the tunnel takes none now. */
export type OpenShareStream = (headers: OutgoingHttpHeaders) => ClientHttp2Stream | undefined;

/** A visitor answer the relay gives itself. */
export interface RelayAnswer {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

export const NOT_CONNECTED: RelayAnswer = {
  status: 503,
  body: "This share is not connected.",
  headers: { "retry-after": "5" },
};
export const BUSY: RelayAnswer = { status: 503, body: "This share is busy.", headers: { "retry-after": "1" } };
export const NO_SHARE_HERE: RelayAnswer = { status: 404, body: "No share is served at this address." };
export const PORT_NOT_SHARED: RelayAnswer = { status: 404, body: "This share does not serve this port." };
const TUNNEL_ENDED: RelayAnswer = { status: 502, body: "The shared run's tunnel ended before it answered." };
const TIMED_OUT: RelayAnswer = { status: 504, body: "The shared run did not answer in time." };
const NOT_A_WEBSOCKET: RelayAnswer = { status: 501, body: "A share forwards only WebSocket upgrades." };
const NO_WEBSOCKET_KEY: RelayAnswer = { status: 400, body: "A WebSocket upgrade needs a Sec-WebSocket-Key." };

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "host",
  "http2-settings",
]);
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function answer(res: ServerResponse, reply: RelayAnswer): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(reply.status, { "content-type": "text/plain", ...reply.headers });
  res.end(reply.body);
}

/** An answer written on an upgrade's raw socket, which then closes. */
export function answerUpgrade(socket: Duplex, reply: RelayAnswer): void {
  const lines = [
    `HTTP/1.1 ${reply.status} ${STATUS_CODES[reply.status] ?? ""}`,
    "Content-Type: text/plain",
    `Content-Length: ${Buffer.byteLength(reply.body)}`,
    "Connection: close",
    ...Object.entries(reply.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
  ];
  socket.end(`${lines.join("\r\n")}\r\n\r\n${reply.body}`);
}

export function forwardVisitorRequest(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  open: OpenShareStream,
  responseTimeoutMs: number,
): void {
  const stream = open({
    ...streamHeaders(req, port),
    ":method": req.method ?? "GET",
    ":path": req.url ?? "/",
  });
  if (stream === undefined) {
    answer(res, NOT_CONNECTED);
    return;
  }
  let responded = false;
  const timer = setTimeout(() => {
    if (responded) return;
    answer(res, TIMED_OUT);
    stream.close(constants.NGHTTP2_CANCEL);
  }, responseTimeoutMs);
  stream.on("response", (headers) => {
    responded = true;
    clearTimeout(timer);
    if (res.headersSent || res.destroyed) {
      stream.close(constants.NGHTTP2_CANCEL);
      return;
    }
    res.writeHead(Number(headers[":status"]), responseHeaders(headers));
    stream.pipe(res);
  });
  stream.on("trailers", (trailers) => res.addTrailers(responseHeaders(trailers)));
  // A reset or a tunnel that ended reaches the visitor as a 502, or as a cut
  // connection once the run's answer has begun.
  const ended = () => {
    clearTimeout(timer);
    if (!responded) {
      if (!res.headersSent) answer(res, TUNNEL_ENDED);
    } else if (stream.rstCode !== constants.NGHTTP2_NO_ERROR && !res.writableFinished) {
      res.destroy();
    }
  };
  stream.on("error", ended);
  stream.on("close", ended);
  req.on("error", () => stream.close(constants.NGHTTP2_CANCEL));
  res.on("close", () => {
    if (!res.writableFinished && !stream.closed) stream.close(constants.NGHTTP2_CANCEL);
  });
  req.pipe(stream);
}

/** Whether an upgrade request asks for a WebSocket. */
export function isWebSocketUpgrade(req: IncomingMessage): boolean {
  return req.method === "GET" && req.headers.upgrade?.toLowerCase() === "websocket";
}

export function forwardVisitorWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  port: number,
  open: OpenShareStream,
  responseTimeoutMs: number,
): void {
  if (!isWebSocketUpgrade(req)) {
    answerUpgrade(socket, NOT_A_WEBSOCKET);
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || key === "") {
    answerUpgrade(socket, NO_WEBSOCKET_KEY);
    return;
  }
  const headers = streamHeaders(req, port);
  delete headers["sec-websocket-key"];
  const stream = open({
    ...headers,
    ":method": "CONNECT",
    ":protocol": "websocket",
    ":path": req.url ?? "/",
  });
  if (stream === undefined) {
    answerUpgrade(socket, NOT_CONNECTED);
    return;
  }
  let responded = false;
  let ended = false;
  const timer = setTimeout(() => {
    if (responded) return;
    ended = true;
    answerUpgrade(socket, TIMED_OUT);
    stream.close(constants.NGHTTP2_CANCEL);
  }, responseTimeoutMs);
  socket.on("error", () => stream.close(constants.NGHTTP2_CANCEL));
  socket.on("close", () => {
    if (!stream.closed) stream.close(constants.NGHTTP2_CANCEL);
  });
  const end = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    if (!responded) answerUpgrade(socket, TUNNEL_ENDED);
    else if (stream.rstCode !== constants.NGHTTP2_NO_ERROR) socket.destroy();
    else socket.end();
  };
  stream.on("error", end);
  stream.on("close", end);
  stream.on("response", (answered) => {
    responded = true;
    clearTimeout(timer);
    if (socket.destroyed) {
      stream.close(constants.NGHTTP2_CANCEL);
      return;
    }
    const status = Number(answered[":status"]);
    if (status === 200) {
      const accept = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
      const fields = responseHeaders(answered);
      delete fields["content-length"];
      delete fields["sec-websocket-accept"];
      socket.write(
        statusLines(101, { ...fields, upgrade: "websocket", connection: "Upgrade", "sec-websocket-accept": accept }),
      );
      if (head.length > 0) stream.write(head);
      socket.pipe(stream);
      stream.pipe(socket);
      return;
    }
    const fields = responseHeaders(answered);
    delete fields["content-length"];
    socket.write(statusLines(status, { ...fields, connection: "close" }));
    stream.pipe(socket);
  });
}

/** A visitor's request headers as a stream carries them: the `Host` as
 *  `:authority`, the target port set by the relay alone. */
function streamHeaders(req: IncomingMessage, port: number): OutgoingHttpHeaders {
  const named = new Set(HOP_BY_HOP);
  const connection = req.headers.connection;
  if (typeof connection === "string") {
    for (const token of connection.split(",")) named.add(token.trim().toLowerCase());
  }
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || named.has(name) || name === SHARE_PORT_HEADER) continue;
    if (name === "te" && value !== "trailers") continue;
    headers[name] = value;
  }
  headers[":authority"] = req.headers.host;
  headers[":scheme"] = "https";
  headers[SHARE_PORT_HEADER] = String(port);
  return headers;
}

function responseHeaders(headers: IncomingHttpHeaders & IncomingHttpStatusHeader): Record<string, string | string[]> {
  const fields: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name.startsWith(":")) continue;
    fields[name] = value as string | string[];
  }
  return fields;
}

function statusLines(status: number, fields: Record<string, string | string[]>): string {
  const lines = [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}`];
  for (const [name, value] of Object.entries(fields)) {
    for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}
