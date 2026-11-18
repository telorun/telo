// One visitor stream of the tunnel's HTTP/2 connection, forwarded to the local
// port the relay named: a request becomes an HTTP/1.1 request, an RFC 8441
// extended CONNECT for `websocket` an HTTP/1.1 upgrade whose bytes are then
// piped both ways.

import http from "node:http";
import {
  constants,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type ServerHttp2Stream,
} from "node:http2";

import { SHARE_PORT_HEADER } from "./tunnel-protocol.js";

export interface LocalTarget {
  /** Whether the client's last `ports` message announced this port. */
  isAnnounced(port: number): boolean;
  /** The pool requests (never upgrades) reuse connections from. */
  agent: http.Agent;
  /** Reports why a stream could not be forwarded; the visitor's answer does not carry it. */
  forwardFailed(port: number, message: string): void;
  /** Reports that the local port answered a stream. */
  forwardAnswered(port: number): void;
}

/** The host every stream is forwarded to. */
export const LOCAL_HOST = "127.0.0.1";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"]);
const NO_BODY_STATUSES = new Set([204, 205, 304]);

export function forwardShareStream(stream: ServerHttp2Stream, headers: IncomingHttpHeaders, target: LocalTarget): void {
  const port = sharePort(headers[SHARE_PORT_HEADER]);
  if (port === undefined) {
    answerPlain(stream, 404, "This share's relay named no port.\n");
    return;
  }
  if (!target.isAnnounced(port)) {
    answerPlain(stream, 404, `This share does not serve port ${port}.\n`);
    return;
  }
  if (headers[":method"] === "CONNECT") {
    if (headers[":protocol"] === "websocket") forwardWebSocket(stream, headers, port, target);
    else answerPlain(stream, 501, "A share forwards only WebSocket CONNECT streams.\n");
    return;
  }
  forwardRequest(stream, headers, port, target);
}

function forwardRequest(stream: ServerHttp2Stream, headers: IncomingHttpHeaders, port: number, target: LocalTarget): void {
  const request = http.request({
    host: LOCAL_HOST,
    port,
    method: headers[":method"],
    path: headers[":path"],
    headers: localRequestHeaders(headers),
    agent: target.agent,
  });
  let response: http.IncomingMessage | undefined;
  request.on("information", (info) => {
    if (stream.headersSent || stream.destroyed) return;
    stream.additionalHeaders({ ":status": info.statusCode, ...visitorResponseHeaders(info.headers) });
  });
  request.on("response", (res) => {
    response = res;
    target.forwardAnswered(port);
    relayResponse(stream, res, headers[":method"] === "HEAD");
  });
  request.on("error", (error) => failLocally(stream, port, error, target));
  stream.on("error", () => request.destroy());
  stream.on("close", () => {
    if (response === undefined || !response.complete) request.destroy();
  });
  stream.pipe(request);
}

function forwardWebSocket(stream: ServerHttp2Stream, headers: IncomingHttpHeaders, port: number, target: LocalTarget): void {
  const outgoing = localRequestHeaders(headers);
  outgoing.connection = "Upgrade";
  outgoing.upgrade = "websocket";
  outgoing["sec-websocket-key"] = webSocketKey();
  outgoing["sec-websocket-version"] ??= "13";
  const request = http.request({ host: LOCAL_HOST, port, method: "GET", path: headers[":path"], headers: outgoing, agent: false });
  let upgraded = false;
  request.on("upgrade", (res, socket, head) => {
    upgraded = true;
    target.forwardAnswered(port);
    if (stream.destroyed || stream.closed) {
      socket.destroy();
      return;
    }
    const answer: OutgoingHttpHeaders = { ":status": 200, ...visitorResponseHeaders(res.headers) };
    delete answer["sec-websocket-accept"];
    stream.respond(answer);
    if (head.length > 0) stream.write(head);
    socket.on("error", () => stream.close(constants.NGHTTP2_CONNECT_ERROR));
    stream.on("error", () => socket.destroy());
    stream.on("close", () => socket.destroy());
    socket.pipe(stream);
    stream.pipe(socket);
  });
  request.on("response", (res) => {
    target.forwardAnswered(port);
    relayResponse(stream, res, false);
  });
  request.on("error", (error) => failLocally(stream, port, error, target));
  stream.on("close", () => {
    if (!upgraded) request.destroy();
  });
  stream.on("error", () => {
    if (!upgraded) request.destroy();
  });
  request.end();
}

function relayResponse(stream: ServerHttp2Stream, res: http.IncomingMessage, head: boolean): void {
  if (stream.destroyed || stream.closed) {
    res.destroy();
    return;
  }
  const status = res.statusCode ?? 502;
  const waitForTrailers = res.headers.trailer !== undefined && !head && !NO_BODY_STATUSES.has(status);
  stream.respond({ ":status": status, ...visitorResponseHeaders(res.headers) }, { waitForTrailers });
  if (waitForTrailers) {
    stream.once("wantTrailers", () => stream.sendTrailers(visitorResponseHeaders(res.trailers)));
  }
  res.on("error", () => stream.close(constants.NGHTTP2_INTERNAL_ERROR));
  res.on("aborted", () => stream.close(constants.NGHTTP2_INTERNAL_ERROR));
  res.pipe(stream);
}

/** The local port refused or broke the request: a `502` while nothing was answered, else a reset stream. */
function failLocally(stream: ServerHttp2Stream, port: number, error: Error, target: LocalTarget): void {
  if (stream.destroyed || stream.closed) return;
  target.forwardFailed(port, error.message);
  if (stream.headersSent) stream.close(constants.NGHTTP2_INTERNAL_ERROR);
  else answerPlain(stream, 502, `Nothing answered on port ${port} of the shared run.\n`);
}

function answerPlain(stream: ServerHttp2Stream, status: number, body: string): void {
  if (stream.destroyed || stream.closed) return;
  stream.on("error", () => stream.destroy());
  stream.respond({ ":status": status, "content-type": "text/plain; charset=utf-8" });
  stream.end(body);
}

function sharePort(value: string | string[] | undefined): number | undefined {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,4}$/.test(value)) return undefined;
  const port = Number(value);
  return port <= 65535 ? port : undefined;
}

/** The visitor's headers as the local server receives them: its `Host`, without the relay's port header. */
function localRequestHeaders(headers: IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const outgoing: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name.startsWith(":") || name === SHARE_PORT_HEADER || name === "host") continue;
    outgoing[name] = value;
  }
  const authority = headers[":authority"] ?? headers.host;
  if (authority !== undefined) outgoing.host = authority;
  return outgoing;
}

/** A local response's headers as HTTP/2 carries them: no connection-specific field. */
function visitorResponseHeaders(headers: http.IncomingHttpHeaders | NodeJS.Dict<string>): OutgoingHttpHeaders {
  const named = new Set(HOP_BY_HOP);
  const connection = headers.connection;
  if (typeof connection === "string") {
    for (const token of connection.split(",")) named.add(token.trim().toLowerCase());
  }
  const outgoing: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || named.has(name)) continue;
    outgoing[name] = value;
  }
  return outgoing;
}

/** A `Sec-WebSocket-Key`: a nonce, not a secret (RFC 6455 §4.1). */
function webSocketKey(): string {
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes.toString("base64");
}
