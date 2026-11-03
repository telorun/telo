import type { ClientCertificate, RequestTls } from "@telorun/http-dispatch";
import type { FastifyRequest } from "fastify";
import { X509Certificate } from "node:crypto";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import {
  certificateRecord,
  readForwardedCertificate,
  type ForwardedClientCertificate,
} from "./client-certificate.js";

/** What a request's connection says about it, read on first use. */
export interface RequestConnection {
  readonly tls: RequestTls | null;
  readonly clientCertificate: ClientCertificate | null;
}

/** Called with the reason a forwarded certificate header could not be read. */
export type ForwardedUnreadable = (reason: string) => void;

/**
 * One request's connection facts. The certificate is the listener's when it
 * verified one, else the one a trusted proxy forwarded, else whatever the
 * listener received unverified.
 */
export function requestConnection(
  request: FastifyRequest,
  forwarded: ForwardedClientCertificate | undefined,
  onUnreadable: ForwardedUnreadable,
): RequestConnection {
  const socket = tlsSocketOf(request.raw.socket);
  let tls: RequestTls | null | undefined;
  let certificate: ClientCertificate | null | undefined;
  return {
    get tls() {
      if (tls === undefined) tls = socketTls(socket);
      return tls;
    },
    get clientCertificate() {
      if (certificate === undefined) {
        const own = listenerCertificate(socket);
        certificate =
          own?.verified ? own : (forwardedCertificate(request, forwarded, onUnreadable) ?? own);
      }
      return certificate;
    },
  };
}

/** `target` carrying `tls` and `clientCertificate`, each read through
 *  `connection` only when an expression reads it. Non-enumerable, like `lang`. */
export function withConnection<T extends object>(
  target: T,
  connection: RequestConnection,
): T & RequestConnection {
  Object.defineProperty(target, "tls", {
    get: () => connection.tls,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(target, "clientCertificate", {
    get: () => connection.clientCertificate,
    enumerable: false,
    configurable: true,
  });
  return target as T & RequestConnection;
}

function socketTls(socket: TLSSocket | null): RequestTls | null {
  const protocol = socket?.getProtocol();
  return protocol ? { protocol } : null;
}

function listenerCertificate(socket: TLSSocket | null): ClientCertificate | null {
  if (!socket) return null;
  const raw = socket.getPeerCertificate().raw;
  if (!raw || raw.length === 0) return null;
  return certificateRecord(new X509Certificate(raw), socket.authorized === true, "listener");
}

function forwardedCertificate(
  request: FastifyRequest,
  forwarded: ForwardedClientCertificate | undefined,
  onUnreadable: ForwardedUnreadable,
): ClientCertificate | null {
  if (!forwarded) return null;
  const value = request.headers[forwarded.header.toLowerCase()];
  if (value === undefined || value === "") return null;
  if (typeof value !== "string") {
    onUnreadable("the header arrived more than once");
    return null;
  }
  const read = readForwardedCertificate(value, forwarded.format);
  if ("unreadable" in read) {
    onUnreadable(read.unreadable);
    return null;
  }
  return certificateRecord(read.certificate, false, "proxy");
}

/** The socket's TLS session; every encrypted socket is one the server's own TLS listener handshook. */
function tlsSocketOf(socket: Socket): TLSSocket | null {
  return (socket as Partial<TLSSocket>).encrypted === true ? (socket as TLSSocket) : null;
}
