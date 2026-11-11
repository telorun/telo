import type { HostListeners } from "@telorun/kernel";
import type * as net from "node:net";

import { sameSecret } from "./desktop-control-channel.js";

/**
 * Admission of the window's connections on the application's origin, before the
 * kernel sees them (`kernel/specs/desktop-host.md` §5.5). The first request of each
 * connection is read — its head, bounded in size and time — and decided:
 *
 * - `Host` must be exactly `127.0.0.1:<port>`;
 * - a request carrying the `telo-window` cookie, whose `Origin` is absent, the
 *   app's origin or the host's, is handed whole to the kernel's listener with the
 *   bytes already read, and the host reads nothing more of that connection;
 * - any other request is put to {@link AdmissionOptions.unadmittedRequest} (the
 *   armed sign-in return), and refused with `403` when it answers nothing.
 *
 * The host answers nothing else here: every page it shows a window is served on
 * its own origin (`desktop-host-origin.ts`), because a connection handed to the
 * kernel is never read again. The request reading below is shared with it.
 */

export const WINDOW_COOKIE = "telo-window";

/** The first request of a connection, as admission read it. */
export interface AdmissionRequest {
  method: string;
  /** The request target as written: path and query. */
  target: string;
  path: string;
  /** The raw query, without `?`; empty when there is none. */
  query: string;
  /** Header values by lower-case name, in the order they arrived. */
  headers: ReadonlyMap<string, readonly string[]>;
  peer: string;
}

/** A response the host writes itself; the connection is closed after it. */
export interface HostResponse {
  status: number;
  reason: string;
  headers?: ReadonlyArray<readonly [string, string]>;
  body?: string | Uint8Array;
}

/** A host page that needs the request's body: admission reads at most `maxBytes`
 *  (the `Content-Length`, which must be present and within it) and answers with
 *  what `onBody` returns. */
export interface HostBodyRequest {
  maxBytes: number;
  onBody(body: Buffer): HostResponse;
}

export type HostAnswer = HostResponse | HostBodyRequest;

export interface HeadLimits {
  /** How long a connection may take to send its first request's head. */
  headTimeoutMs?: number;
  /** The largest head read before it is refused. */
  maxHeadBytes?: number;
}

export interface AdmissionOptions extends HeadLimits {
  port: number;
  /** `http://127.0.0.1:<port>` */
  origin: string;
  /** The host's own origin, which the sign-in form's submission carries as `Origin`. */
  hostOrigin: string;
  listeners: HostListeners;
  /** The `telo-window` cookie's value: the per-launch admission secret. */
  secret: string;
  /** Asked before a request that is not admitted — no cookie, or a foreign `Origin` (its `Host` is still checked) —
   *  is refused; `undefined` refuses it. */
  unadmittedRequest?: (request: AdmissionRequest) => HostAnswer | undefined;
}

/** What {@link readFirstRequest} hands on: the parsed request (none for a malformed
 *  head), everything read so far and where the body starts in it. */
export interface FirstRequest {
  request: AdmissionRequest | undefined;
  read: Buffer;
  bodyStart: number;
}

const HEAD_END = Buffer.from("\r\n\r\n");
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const REQUEST_LINE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+) (\S+) HTTP\/1\.[01]$/;

export class DesktopAdmission {
  private readonly host: string;

  constructor(
    server: net.Server,
    private readonly options: AdmissionOptions,
  ) {
    this.host = `127.0.0.1:${options.port}`;
    server.on("connection", (socket) => readFirstRequest(socket, options, (first) => this.decide(socket, first)));
  }

  private decide(socket: net.Socket, { request, read, bodyStart }: FirstRequest): void {
    if (!request || !hostIs(request, this.host)) {
      refuse(socket, request?.method);
      return;
    }
    if (this.originAllowed(request) && carriesCookie(request, WINDOW_COOKIE, this.options.secret)) {
      this.options.listeners.admit(this.options.port, { socket, head: read, peer: request.peer });
      return;
    }
    const answer = this.options.unadmittedRequest?.(request);
    if (answer) answerWith(socket, request, read, bodyStart, answer);
    else refuse(socket, request.method);
  }

  private originAllowed(request: AdmissionRequest): boolean {
    const origin = request.headers.get("origin") ?? [];
    return origin.length === 0 || (origin.length === 1 && (origin[0] === this.options.origin || origin[0] === this.options.hostOrigin));
  }
}

/**
 * Reads the head of a connection's first request and hands it to `decide`, the
 * socket paused; a head over the bound or a malformed one is refused, one that does
 * not arrive in time dropped.
 */
export function readFirstRequest(socket: net.Socket, limits: HeadLimits, decide: (first: FirstRequest) => void): void {
  // The host keeps its own error listener for the connection's whole life.
  socket.on("error", () => socket.destroy());
  socket.setTimeout(limits.headTimeoutMs ?? 10_000, () => socket.destroy());
  const maxHead = limits.maxHeadBytes ?? 16 * 1024;
  const chunks: Buffer[] = [];
  let length = 0;
  const onData = (chunk: Buffer): void => {
    chunks.push(chunk);
    length += chunk.length;
    const read = Buffer.concat(chunks, length);
    const end = read.indexOf(HEAD_END);
    if (end < 0 && length <= maxHead) return;
    socket.pause();
    socket.removeListener("data", onData);
    socket.setTimeout(0);
    if (end < 0 || end > maxHead) {
      refuse(socket);
      return;
    }
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    decide({ request: parseHead(read.subarray(0, end).toString("latin1"), peer), read, bodyStart: end + HEAD_END.length });
  };
  socket.on("data", onData);
}

/** The request line and header fields of a head, or `undefined` when it is not one admission reads. */
export function parseHead(head: string, peer: string): AdmissionRequest | undefined {
  const lines = head.split("\r\n");
  const line = REQUEST_LINE.exec(lines[0] ?? "");
  if (!line) return undefined;
  const [, method, target] = line;
  if (!target.startsWith("/")) return undefined;
  const headers = new Map<string, string[]>();
  for (const field of lines.slice(1)) {
    const colon = field.indexOf(":");
    if (colon <= 0) return undefined;
    const name = field.slice(0, colon);
    if (!TOKEN.test(name)) return undefined;
    const key = name.toLowerCase();
    const values = headers.get(key) ?? [];
    values.push(field.slice(colon + 1).trim());
    headers.set(key, values);
  }
  const question = target.indexOf("?");
  return {
    method,
    target,
    path: question < 0 ? target : target.slice(0, question),
    query: question < 0 ? "" : target.slice(question + 1),
    headers,
    peer,
  };
}

/** Whether the request names exactly one `Host`, and it is `host`. */
export function hostIs(request: AdmissionRequest, host: string): boolean {
  const values = request.headers.get("host") ?? [];
  return values.length === 1 && values[0] === host;
}

/** Whether a `Cookie` header carries `name` with the value `secret`. */
export function carriesCookie(request: AdmissionRequest, name: string, secret: string): boolean {
  for (const header of request.headers.get("cookie") ?? []) {
    for (const pair of header.split(";")) {
      const at = pair.indexOf("=");
      if (at < 0 || pair.slice(0, at).trim() !== name) continue;
      if (sameSecret(pair.slice(at + 1).trim(), secret)) return true;
    }
  }
  return false;
}

/** Writes `answer`, first reading the body it asks for. */
export function answerWith(socket: net.Socket, request: AdmissionRequest, read: Buffer, bodyStart: number, answer: HostAnswer): void {
  if ("onBody" in answer) readBody(socket, read, bodyStart, request, answer);
  else respond(socket, request.method, answer);
}

function readBody(socket: net.Socket, read: Buffer, bodyStart: number, request: AdmissionRequest, page: HostBodyRequest): void {
  const lengths = request.headers.get("content-length") ?? [];
  const length = lengths.length === 1 && /^\d{1,9}$/.test(lengths[0]) ? Number(lengths[0]) : undefined;
  if (length === undefined) {
    respond(socket, request.method, { status: 411, reason: "Length Required" });
    return;
  }
  if (length > page.maxBytes) {
    respond(socket, request.method, { status: 413, reason: "Content Too Large" });
    return;
  }
  const chunks = [read.subarray(bodyStart)];
  let received = chunks[0].length;
  const finish = (): void => {
    socket.removeListener("data", onData);
    socket.setTimeout(0);
    respond(socket, request.method, page.onBody(Buffer.concat(chunks).subarray(0, length)));
  };
  const onData = (chunk: Buffer): void => {
    chunks.push(chunk);
    received += chunk.length;
    if (received >= length) finish();
  };
  if (received >= length) {
    finish();
    return;
  }
  socket.setTimeout(10_000, () => socket.destroy());
  socket.on("data", onData);
  socket.resume();
}

export function refuse(socket: net.Socket, method?: string): void {
  respond(socket, method, { status: 403, reason: "Forbidden" });
}

/** Writes the response with `Connection: close` and ends the connection. */
export function respond(socket: net.Socket, method: string | undefined, response: HostResponse): void {
  const body = response.body === undefined ? Buffer.alloc(0) : Buffer.from(response.body);
  const lines = [`HTTP/1.1 ${response.status} ${response.reason}`];
  for (const [name, value] of response.headers ?? []) lines.push(`${name}: ${value}`);
  lines.push(`Content-Length: ${body.length}`, "Connection: close", "", "");
  const headBytes = Buffer.from(lines.join("\r\n"), "latin1");
  socket.end(method === "HEAD" ? headBytes : Buffer.concat([headBytes, body]));
  // Whatever else the peer sends is read and dropped, so closing never resets
  // the connection over unread bytes before the response is read.
  socket.resume();
  socket.setTimeout(5_000, () => socket.destroy());
}
