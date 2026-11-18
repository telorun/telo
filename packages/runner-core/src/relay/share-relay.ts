// The relay engine: it holds share tunnels and answers visitors from them. A
// visitor request is answered from the tunnels held here alone; the share
// directory is written when a tunnel connects, on the renewal tick and on a
// clean close, never per request.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import {
  MessageSizeGuard,
  TUNNEL_BINARY_MESSAGE_MAX_BYTES,
  TUNNEL_SUBPROTOCOL,
  TUNNEL_TEXT_MESSAGE_MAX_BYTES,
  TunnelCloseCode,
  tunnelProofUrl,
} from "@telorun/share-tunnel";
import { WebSocket, WebSocketServer } from "ws";

import type { ShareRouting } from "../backend.js";
import { IdentityProviderUnavailable, IdentityRefusal } from "../identity/identity-refusal.js";
import type { LeaseHold, LeaseRenewal } from "../session-store/share-store.js";
import {
  DEFAULT_SHARE_RELAY_TIMINGS,
  fitCloseReason,
  RelayTunnel,
  type RelayLog,
  type ShareRelayTimings,
  type TunnelHolder,
} from "./relay-tunnel.js";
import type { ShareDirectory } from "./share-directory.js";
import type { TunnelAuthenticator, TunnelIdentity } from "./tunnel-authenticator.js";
import { parseVisitorHost } from "./visitor-host.js";
import {
  answer,
  answerUpgrade,
  BUSY,
  forwardVisitorRequest,
  forwardVisitorWebSocket,
  NO_SHARE_HERE,
  NOT_CONNECTED,
  PORT_NOT_SHARED,
  type RelayAnswer,
} from "./visitor-forwarding.js";

export interface ShareRelayDeps {
  routing: ShareRouting;
  directory: ShareDirectory;
  authenticator: TunnelAuthenticator;
  /** Visitor requests in flight per tunnel, an open visitor WebSocket included. */
  maxConcurrentRequests: number;
  /** Bytes per second per tunnel, each direction. */
  maxBytesPerSecond: number;
  log: RelayLog;
  timings?: Partial<ShareRelayTimings>;
}

const TUNNEL_PATH = /^\/v1\/shares\/([a-z2-7]{12})\/tunnel$/;

export class ShareRelay implements TunnelHolder {
  readonly directory: ShareDirectory;
  readonly authenticator: TunnelAuthenticator;
  readonly timings: ShareRelayTimings;
  readonly log: RelayLog;
  readonly maxConcurrentRequests: number;
  readonly maxBytesPerSecond: number;

  private readonly routing: ShareRouting;
  /** The tunnel each share's visitors are sent through. */
  private readonly routed = new Map<string, RelayTunnel>();
  /** The tunnel whose lease this relay renews, per share. */
  private readonly held = new Map<string, RelayTunnel>();
  private readonly tunnels = new Set<RelayTunnel>();
  /** Visitors' upgraded sockets, which no HTTP server closes. */
  private readonly visitorSockets = new Set<Duplex>();
  private readonly wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    // Sizes are judged per type, before the payload, by the tunnel's guard.
    maxPayload: 0,
    handleProtocols: (offered) => (offered.has(TUNNEL_SUBPROTOCOL) ? TUNNEL_SUBPROTOCOL : false),
  });
  private renewing: Promise<void> = Promise.resolve();
  private renewTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(deps: ShareRelayDeps) {
    this.routing = deps.routing;
    this.directory = deps.directory;
    this.authenticator = deps.authenticator;
    this.maxConcurrentRequests = deps.maxConcurrentRequests;
    this.maxBytesPerSecond = deps.maxBytesPerSecond;
    this.log = deps.log;
    this.timings = { ...DEFAULT_SHARE_RELAY_TIMINGS, ...deps.timings };
  }

  /** Starts the lease renewal. */
  start(): void {
    const tick = () => {
      this.renewTimer = undefined;
      this.renewing = this.renew().finally(() => {
        if (!this.stopped) this.renewTimer = setTimeout(tick, this.timings.renewIntervalMs);
      });
    };
    this.renewTimer = setTimeout(tick, this.timings.renewIntervalMs);
  }

  /** Closes every tunnel `1001` and stops renewing; leases lapse on their own. */
  async close(): Promise<void> {
    this.stopped = true;
    if (this.renewTimer !== undefined) clearTimeout(this.renewTimer);
    const closing = [...this.tunnels].map((tunnel) => {
      tunnel.close(1001, "the relay is shutting down");
      return tunnel.closed;
    });
    for (const socket of this.visitorSockets) socket.destroy();
    await Promise.all([...closing, this.renewing]);
    this.wss.close();
  }

  /** A plain HTTP request: a visitor's. */
  handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const target = this.visitorTarget(req);
    if ("reply" in target) return answer(res, target.reply);
    forwardVisitorRequest(req, res, target.port, (headers) => target.tunnel.openStream(headers), this.timings.responseTimeoutMs);
  }

  /** An upgrade: a visitor's WebSocket, or a share tunnel at its endpoint. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on("error", () => socket.destroy());
    if (parseVisitorHost(req.headers.host, this.routing.baseDomain) !== undefined) {
      const target = this.visitorTarget(req);
      if ("reply" in target) return answerUpgrade(socket, target.reply);
      this.visitorSockets.add(socket);
      socket.once("close", () => this.visitorSockets.delete(socket));
      forwardVisitorWebSocket(
        req,
        socket,
        head,
        target.port,
        (headers) => target.tunnel.openStream(headers),
        this.timings.responseTimeoutMs,
      );
      return;
    }
    const shareId = this.tunnelEndpoint(req);
    if (shareId === undefined) return answerUpgrade(socket, NO_SHARE_HERE);
    this.acceptTunnel(req, socket, head, shareId).catch((err: unknown) => {
      this.log.error({ share: shareId, err: (err as Error).message }, "a share tunnel upgrade failed");
      socket.destroy();
    });
  }

  connected(tunnel: RelayTunnel): boolean {
    const previous = this.held.get(tunnel.shareId);
    if (previous !== undefined && previous !== tunnel) {
      if (previous.epoch! > tunnel.epoch!) return false;
      this.held.delete(tunnel.shareId);
      if (this.routed.get(tunnel.shareId) === previous) this.routed.delete(tunnel.shareId);
      // The same epoch is the same run reconnecting: the older socket is stale.
      if (previous.epoch === tunnel.epoch) previous.close(1001, "the run reconnected");
      else previous.supersede();
    }
    this.held.set(tunnel.shareId, tunnel);
    return true;
  }

  routable(tunnel: RelayTunnel): void {
    if (this.held.get(tunnel.shareId) === tunnel) this.routed.set(tunnel.shareId, tunnel);
  }

  unroutable(tunnel: RelayTunnel): void {
    if (this.routed.get(tunnel.shareId) === tunnel) this.routed.delete(tunnel.shareId);
  }

  superseded(tunnel: RelayTunnel): void {
    this.unroutable(tunnel);
    if (this.held.get(tunnel.shareId) === tunnel) this.held.delete(tunnel.shareId);
  }

  ended(tunnel: RelayTunnel, clean: boolean): void {
    this.tunnels.delete(tunnel);
    if (this.routed.get(tunnel.shareId) === tunnel) this.routed.delete(tunnel.shareId);
    const held = this.held.get(tunnel.shareId) === tunnel;
    if (held) this.held.delete(tunnel.shareId);
    this.log.info({ share: tunnel.shareId, epoch: tunnel.epoch, clean }, "a share tunnel ended");
    if (held && clean && tunnel.epoch !== undefined) this.release({ id: tunnel.shareId, epoch: tunnel.epoch });
  }

  release(hold: LeaseHold): void {
    // After any renewal in flight, so a renewal cannot extend a lease ended here.
    this.renewing = this.renewing
      .then(() => this.directory.release(hold))
      .then(
        () => undefined,
        (err: unknown) => {
          this.log.error({ share: hold.id, err: (err as Error).message }, "a share's lease could not be released; it lapses");
        },
      );
  }

  private visitorTarget(req: IncomingMessage): { reply: RelayAnswer } | { tunnel: RelayTunnel; port: number } {
    const visitor = parseVisitorHost(req.headers.host, this.routing.baseDomain);
    if (visitor === undefined) return { reply: NO_SHARE_HERE };
    const tunnel = this.routed.get(visitor.shareId);
    if (tunnel === undefined) return { reply: NOT_CONNECTED };
    if (!tunnel.servesPort(visitor.port)) return { reply: PORT_NOT_SHARED };
    if (tunnel.busy) return { reply: BUSY };
    return { tunnel, port: visitor.port };
  }

  /** The share whose tunnel endpoint the request names, at the tunnel URL's host. */
  private tunnelEndpoint(req: IncomingMessage): string | undefined {
    const path = (req.url ?? "").split("?", 1)[0]!;
    const shareId = TUNNEL_PATH.exec(path)?.[1];
    if (shareId === undefined || req.headers.host === undefined) return undefined;
    const tunnelUrl = new URL(this.routing.addresses(shareId).tunnelUrl);
    try {
      return new URL(`${tunnelUrl.protocol}//${req.headers.host}`).host === tunnelUrl.host ? shareId : undefined;
    } catch {
      // A `Host` no URL can hold names no endpoint.
      return undefined;
    }
  }

  private async acceptTunnel(req: IncomingMessage, socket: Duplex, head: Buffer, shareId: string): Promise<void> {
    const htu = tunnelProofUrl(this.routing.addresses(shareId).tunnelUrl);
    const verdict = await this.authenticateUpgrade(req, htu);
    if (socket.destroyed || this.stopped) {
      socket.destroy();
      return;
    }
    let tunnel: RelayTunnel | undefined;
    let ws: WebSocket | undefined;
    // ws emits nothing for a message before reading all of it: the guard reads
    // frame headers off the socket first, so an oversize message is refused
    // before its payload is buffered.
    const guard = new MessageSizeGuard(
      { textBytes: TUNNEL_TEXT_MESSAGE_MAX_BYTES, binaryBytes: TUNNEL_BINARY_MESSAGE_MAX_BYTES },
      (oversize) => {
        const detail = `a ${oversize.kind} message over ${oversize.limit} bytes`;
        if (tunnel !== undefined) tunnel.close(TunnelCloseCode.protocolError, detail);
        else ws?.terminate();
      },
    );
    this.wss.handleUpgrade(req, socket, head, (accepted) => {
      ws = accepted;
      if ("refusal" in verdict) {
        closeRefused(accepted, verdict.refusal.code, verdict.refusal.reason, this.timings.closeGraceMs);
        return;
      }
      tunnel = new RelayTunnel(this, accepted, shareId, htu, verdict.identity);
      this.tunnels.add(tunnel);
    });
    // After handleUpgrade, which unshifts `head` onto the socket: a listener attached
    // before it would take the head and ws would never see it. Prepended, it still
    // reads every chunk (the head once) ahead of ws's own reader.
    socket.prependListener("data", (chunk: Buffer) => guard.write(chunk));
  }

  /** The upgrade's credential, judged; a refusal is closed after the upgrade so the client reads it. */
  private async authenticateUpgrade(
    req: IncomingMessage,
    htu: string,
  ): Promise<{ identity: TunnelIdentity } | { refusal: { code: number; reason: string } }> {
    const authorization = req.headers.authorization;
    const match = typeof authorization === "string" ? /^DPoP\s+(\S+)$/i.exec(authorization.trim()) : null;
    if (match === null) {
      return { refusal: { code: TunnelCloseCode.credentialRefused, reason: "the upgrade carries no DPoP access token" } };
    }
    try {
      return { identity: await this.authenticator.authenticate({ accessToken: match[1]!, proof: req.headers.dpop }, htu) };
    } catch (err) {
      if (err instanceof IdentityRefusal) return { refusal: { code: TunnelCloseCode.credentialRefused, reason: err.message } };
      if (err instanceof IdentityProviderUnavailable) {
        this.log.warn({ issuer: err.issuer, err: err.message }, "a share tunnel's identity provider is unavailable");
        return { refusal: { code: 1013, reason: "the identity provider is unavailable" } };
      }
      this.log.error({ err: (err as Error).message }, "a share tunnel's credential could not be verified");
      return { refusal: { code: 1011, reason: "the relay could not verify the credential" } };
    }
  }

  private async renew(): Promise<void> {
    const tunnels = [...this.held.values()];
    if (tunnels.length === 0) return;
    const holds = tunnels.map((tunnel) => ({ id: tunnel.shareId, epoch: tunnel.epoch! }));
    let renewals: LeaseRenewal[];
    try {
      renewals = await this.directory.renew(holds);
    } catch (err) {
      this.log.error(
        { shares: holds.length, err: (err as Error).message },
        "the share leases could not be renewed; they lapse unless a later renewal lands",
      );
      return;
    }
    for (const renewal of renewals) {
      const tunnel = this.held.get(renewal.id);
      if (tunnel === undefined || tunnel.epoch !== renewal.epoch) continue;
      if (renewal.outcome === "gone") tunnel.close(TunnelCloseCode.shareGone, "the share was deleted");
      else if (renewal.outcome === "epoch_moved") tunnel.supersede();
    }
  }
}

function closeRefused(ws: WebSocket, code: number, reason: string, graceMs: number): void {
  ws.on("error", () => ws.terminate());
  ws.close(code, fitCloseReason(reason));
  const timer = setTimeout(() => ws.terminate(), graceMs);
  ws.once("close", () => clearTimeout(timer));
}
