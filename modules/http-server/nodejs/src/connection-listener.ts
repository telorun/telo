import type { FastifyServerOptions } from "fastify";
import { lookup } from "node:dns/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import tls, { type TLSSocket } from "node:tls";
import type { ClaimedListener, HandedConnection } from "@telorun/sdk";
import type { HttpsOptions } from "./tls-material.js";
import { HandedSocket } from "./handed-socket.js";

/** How long a TLS handshake may take before its connection is dropped. */
export const TLS_HANDSHAKE_TIMEOUT_MS = 120_000;

/** A TLS connection that closed before it was served: its peer and why. */
export interface HandshakeFailure {
  address?: string;
  port?: number;
  type: string;
  message: string;
}

/** A resolved address the host has no interface for, left unbound. */
export interface UnavailableAddress {
  address: string;
  port: number;
  type: string;
  message: string;
}

export interface ConnectionListenerSettings {
  /** An IP address, bound as written, or a hostname, bound on every address it resolves to. */
  address: string;
  port: number;
  tls?: HttpsOptions;
  onHandshakeFailure(failure: HandshakeFailure): void;
  onAddressUnavailable(unavailable: UnavailableAddress): void;
  /** Resolves a hostname to its addresses; DNS by default. */
  resolve?(hostname: string): Promise<string[]>;
  /** Claims the host's socket for the port, handing each connection it admits
   *  to `accept`; null when the host holds none, and the port is bound. */
  claim?(port: number, accept: (connection: HandedConnection) => void): Promise<ClaimedListener | null>;
}

/** The bind failures that mean the host lacks the address or its family, not that the bind is wrong. */
const UNAVAILABLE = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

/** One accepted connection: the socket the listener took, and the one it handed to HTTP. */
interface Connection {
  readonly socket: Socket;
  readonly address?: string;
  readonly port?: number;
  served?: Socket;
  inFlight: number;
  failure?: { type: string; message: string };
}

type ServerFactory = NonNullable<FastifyServerOptions["serverFactory"]>;

/**
 * The sockets an `Http.Server` listens on — net servers, or TLS servers when
 * `tls` is set, one per bound address — handing each accepted (for TLS,
 * handshaken) connection to Fastify's HTTP layer. Owning the listener is what
 * makes a request's TLS session and client certificate socket facts on every host.
 */
export class ConnectionListener {
  private readonly settings: ConnectionListenerSettings;
  private readonly listeners: net.Server[] = [];
  private readonly connections = new Map<Socket, Connection>();
  /** TLS connections in their handshake, by peer: the secured socket may be another object. */
  private readonly handshaking = new Map<string, Connection>();
  private readonly served = new WeakMap<Socket, Connection>();
  private http: http.Server | undefined;
  private draining = false;
  /** The host's socket, when the server serves it instead of binding. */
  private supplied: { claim: ClaimedListener; listener: net.Server } | undefined;
  private onIdle: (() => void) | undefined;

  constructor(settings: ConnectionListenerSettings) {
    this.settings = settings;
  }

  /** Whether the listener is closing: a response now ends its connection. */
  get closing(): boolean {
    return this.draining;
  }

  /** Fastify's `serverFactory`: the HTTP layer, configured as Fastify configures its own. */
  readonly serverFactory: ServerFactory = (handler, options) => {
    // Fastify fills these with its defaults before it calls the factory.
    const { keepAliveTimeout, requestTimeout, connectionTimeout, maxRequestsPerSocket } = options as {
      keepAliveTimeout: number;
      requestTimeout: number;
      connectionTimeout: number;
      maxRequestsPerSocket: number;
    };
    const server = http.createServer((request, response) => {
      this.track(request, response);
      handler(request, response);
    });
    server.keepAliveTimeout = keepAliveTimeout;
    server.requestTimeout = requestTimeout;
    server.setTimeout(connectionTimeout);
    if (maxRequestsPerSocket > 0) server.maxRequestsPerSocket = maxRequestsPerSocket;
    this.http = server;
    return server;
  };

  /** The bound addresses, each on the same port — the first bind's when `port` is 0. */
  get bound(): AddressInfo[] {
    return this.listeners.map((listener) => listener.address() as AddressInfo);
  }

  /** The address of the host's socket when the server serves it, else undefined. */
  get suppliedAddress(): string | undefined {
    return this.supplied?.claim.address;
  }

  /**
   * Binds every address: an IP literal alone, a hostname each address it
   * resolves to. A resolved address the host has no interface for is reported
   * and left unbound; any other failure, or none bound, fails and closes what bound.
   */
  async listen(): Promise<void> {
    if (await this.claimSupplied()) {
      this.httpLayer().emit("listening");
      return;
    }
    const { address } = this.settings;
    const literal = net.isIP(address) !== 0;
    const addresses = literal ? [address] : await this.resolve(address);
    let port = this.settings.port;
    let firstUnavailable: unknown;
    try {
      for (const host of addresses) {
        const listener = this.createListener();
        try {
          await bind(listener, host, port);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (literal || code === undefined || !UNAVAILABLE.has(code)) throw error;
          firstUnavailable ??= error;
          this.settings.onAddressUnavailable({ address: host, port, type: code, message: (error as Error).message });
          continue;
        }
        this.listeners.push(listener);
        port = (listener.address() as AddressInfo).port;
      }
      if (this.listeners.length === 0) {
        throw firstUnavailable ?? new Error(`Http.Server: '${address}' resolved to no address`);
      }
    } catch (error) {
      await this.closeListeners().catch((closing: unknown) => {
        throw new AggregateError([error, closing], `Http.Server: binding '${address}' failed, and so did closing what bound`);
      });
      throw error;
    }
    // Arms the HTTP layer's header and request timeouts, which start on its own `listening`.
    this.httpLayer().emit("listening");
  }

  /**
   * Stops accepting, ends every idle connection at once and every busy one when
   * its last response is done, and resolves once all of them have closed.
   */
  async close(): Promise<void> {
    this.draining = true;
    const closed = this.supplied ? this.releaseSupplied() : this.closeListeners();
    for (const connection of this.connections.values()) {
      if (connection.inFlight === 0) end(connection);
    }
    await closed;
    // Stops the HTTP layer's timeout checks; it never listened, so nothing else closes.
    this.httpLayer().close();
  }

  /**
   * Claims the host's socket, before anything binds. Each handed connection is
   * emitted on a listener that never binds, which serves it as an accepted one —
   * through the TLS handshake when `tls` is set.
   */
  private async claimSupplied(): Promise<boolean> {
    if (!this.settings.claim) return false;
    const listener = this.createListener();
    const claim = await this.settings.claim(this.settings.port, (connection) => {
      if (this.draining) {
        void connection.close({ code: "ECONNREFUSED", message: "the server is closing" });
        return;
      }
      listener.emit("connection", new HandedSocket(connection));
    });
    if (!claim) return false;
    this.supplied = { claim, listener };
    return true;
  }

  /** Releases the host's socket, then resolves once every handed connection has closed. */
  private async releaseSupplied(): Promise<void> {
    await this.supplied!.claim.release();
    if (this.connections.size === 0) return;
    await new Promise<void>((resolve) => {
      this.onIdle = resolve;
    });
  }

  private async resolve(hostname: string): Promise<string[]> {
    const resolved = this.settings.resolve
      ? await this.settings.resolve(hostname)
      : (await lookup(hostname, { all: true })).map((entry) => entry.address);
    return [...new Set(resolved)];
  }

  private createListener(): net.Server {
    if (!this.settings.tls) return net.createServer((socket) => this.handOff(this.accept(socket), socket));
    const { requireVerifiedClient, ...options } = this.settings.tls;
    const listener = tls.createServer({ ...options, handshakeTimeout: TLS_HANDSHAKE_TIMEOUT_MS });
    listener.on("connection", (socket: Socket) => this.accept(socket));
    listener.on("secureConnection", (socket: TLSSocket) => this.secured(socket, requireVerifiedClient === true));
    listener.on("tlsClientError", (error: Error & { code?: string }, socket: TLSSocket) =>
      this.handshakeFailed(error, socket),
    );
    return listener;
  }

  /** Resolves once every listener has closed, failing with every close error. */
  private async closeListeners(): Promise<void> {
    const outcomes = await Promise.allSettled(
      this.listeners.splice(0).map(
        (listener) =>
          new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve()))),
      ),
    );
    const failures = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
      .map((outcome) => outcome.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Http.Server: closing its listeners failed");
  }

  private httpLayer(): http.Server {
    if (!this.http) throw new Error("Http.Server: the HTTP layer was never created");
    return this.http;
  }

  private accept(socket: Socket): Connection {
    const connection: Connection = {
      socket,
      address: socket.remoteAddress,
      port: socket.remotePort,
      inFlight: 0,
    };
    this.connections.set(socket, connection);
    const peer = peerKey(socket);
    if (this.settings.tls && peer !== undefined) this.handshaking.set(peer, connection);
    socket.once("close", () => this.closed(connection, peer));
    return connection;
  }

  private connectionOf(socket: TLSSocket): Connection {
    const peer = peerKey(socket);
    return (
      this.connections.get(socket) ??
      (peer === undefined ? undefined : this.handshaking.get(peer)) ??
      this.accept(socket)
    );
  }

  private secured(socket: TLSSocket, requireVerifiedClient: boolean): void {
    const connection = this.connectionOf(socket);
    const peer = peerKey(socket);
    if (peer !== undefined) this.handshaking.delete(peer);
    if (requireVerifiedClient && !socket.authorized) {
      connection.failure = socket.getPeerCertificate().raw
        ? {
            type: String(socket.authorizationError),
            message: `the client certificate does not verify against clientCa (${String(socket.authorizationError)})`,
          }
        : {
            type: "ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE",
            message: "the client presented no certificate",
          };
      socket.destroy();
      return;
    }
    this.handOff(connection, socket);
  }

  /** Recorded on its connection when the socket can still name its peer; reported when it closes. */
  private handshakeFailed(error: Error & { code?: string }, socket: TLSSocket): void {
    const peer = peerKey(socket);
    const connection =
      this.connections.get(socket) ?? (peer === undefined ? undefined : this.handshaking.get(peer));
    if (connection && !connection.failure) {
      connection.failure = { type: error.code ?? error.name, message: error.message };
    }
    socket.destroy();
  }

  private handOff(connection: Connection, socket: Socket): void {
    connection.served = socket;
    this.served.set(socket, connection);
    this.httpLayer().emit("connection", socket);
  }

  private track(request: IncomingMessage, response: ServerResponse): void {
    const connection = this.served.get(request.socket);
    if (!connection) return;
    connection.inFlight++;
    response.once("close", () => {
      connection.inFlight--;
      if (this.draining && connection.inFlight === 0) end(connection);
    });
  }

  private closed(connection: Connection, peer: string | undefined): void {
    this.connections.delete(connection.socket);
    if (this.connections.size === 0) this.onIdle?.();
    if (peer !== undefined && this.handshaking.get(peer) === connection) this.handshaking.delete(peer);
    if (connection.served || (this.draining && !connection.failure)) return;
    this.settings.onHandshakeFailure({
      address: connection.address,
      port: connection.port,
      ...(connection.failure ?? {
        type: "ECONNRESET",
        message: "the connection closed before the TLS handshake completed",
      }),
    });
  }
}

function bind(listener: net.Server, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen({ host, port }, () => {
      listener.off("error", reject);
      resolve();
    });
  });
}

function peerKey(socket: Socket): string | undefined {
  const { remoteAddress, remotePort } = socket;
  return remoteAddress === undefined || remotePort === undefined ? undefined : `${remoteAddress}|${remotePort}`;
}

/** A served connection is ended once what it wrote is flushed; one still in its handshake is dropped. */
function end(connection: Connection): void {
  if (connection.served) connection.served.destroySoon();
  else connection.socket.destroy();
}
