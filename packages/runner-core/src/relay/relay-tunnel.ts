// One share tunnel the relay holds, from the accepted upgrade to its close: the
// fence, the HTTP/2 connection the relay is the client of, keepalive and
// re-authentication. Visitor streams are opened on it by the relay.

import http2, {
  constants,
  type ClientHttp2Session,
  type ClientHttp2Stream,
  type OutgoingHttpHeaders,
} from "node:http2";

import {
  encodeControlMessage,
  readClientControlMessage,
  TunnelCloseCode,
  type ClientControlMessage,
} from "@telorun/share-tunnel";
import { WebSocket } from "ws";

import { IdentityProviderUnavailable, IdentityRefusal } from "../identity/identity-refusal.js";
import type { ConnectShareResult, LeaseHold, ShareOwner } from "../session-store/share-store.js";
import type { ShareDirectory } from "./share-directory.js";
import type { TunnelAuthenticator, TunnelIdentity } from "./tunnel-authenticator.js";
import { TunnelDuplex } from "./tunnel-duplex.js";

/** The relay's clocks. The defaults are the protocol's and the runner's; only a test shortens them. */
export interface ShareRelayTimings {
  /** No `hello` this long after the upgrade closes `4408`. */
  helloTimeoutMs: number;
  /** The relay pings this often. */
  pingIntervalMs: number;
  /** Receiving nothing for this long closes `4408`. */
  silenceMs: number;
  /** Every held lease is renewed this often. */
  renewIntervalMs: number;
  /** A superseded tunnel is closed `4409` this long after its GOAWAY at the latest. */
  goawayGraceMs: number;
  /** A visitor request whose answer has not begun this long after it was sent is answered `504`. */
  responseTimeoutMs: number;
  /** How long a closing handshake may take before the socket is dropped. */
  closeGraceMs: number;
}

export const DEFAULT_SHARE_RELAY_TIMINGS: Readonly<ShareRelayTimings> = {
  helloTimeoutMs: 10_000,
  pingIntervalMs: 20_000,
  silenceMs: 45_000,
  renewIntervalMs: 5_000,
  goawayGraceMs: 10_000,
  responseTimeoutMs: 60_000,
  closeGraceMs: 2_000,
};

export interface RelayLog {
  info(obj: unknown, msg: string): void;
  warn(obj: unknown, msg: string): void;
  error(obj: unknown, msg: string): void;
}

/** What a tunnel needs of the relay holding it. */
export interface TunnelHolder {
  readonly directory: ShareDirectory;
  readonly authenticator: TunnelAuthenticator;
  readonly timings: ShareRelayTimings;
  readonly log: RelayLog;
  readonly maxConcurrentRequests: number;
  readonly maxBytesPerSecond: number;
  /** The tunnel holds the share at its epoch. False when a newer epoch is held
   *  here already, and the tunnel must close superseded. */
  connected(tunnel: RelayTunnel): boolean;
  /** Visitors may be sent through the tunnel. */
  routable(tunnel: RelayTunnel): void;
  /** No new visitor is sent through it. */
  unroutable(tunnel: RelayTunnel): void;
  /** Another run holds the share: its lease is no longer this tunnel's to renew or release. */
  superseded(tunnel: RelayTunnel): void;
  /** It ended; `clean` when the client closed it. */
  ended(tunnel: RelayTunnel, clean: boolean): void;
  /** Ends a lease this relay no longer holds a tunnel for. */
  release(hold: LeaseHold): void;
}

const SHARE_GONE = "no such share for this credential";
const SUPERSEDED = "another run of this share took it over";

export class RelayTunnel {
  /** The epoch the tunnel holds, once its `hello` is answered. */
  epoch: number | undefined;
  /** Resolves once the socket has closed. */
  readonly closed: Promise<void>;

  private phase: "hello" | "connecting" | "open" | "draining" | "closed" = "hello";
  private identity: TunnelIdentity;
  private ports = new Set<number>();
  private queued: Array<{ data: Buffer; isBinary: boolean }> = [];
  private duplex: TunnelDuplex | undefined;
  private session: ClientHttp2Session | undefined;
  private inFlight = 0;
  private drained = false;
  private cleanClose = false;
  private lastReceivedAt = Date.now();
  private authenticating = false;
  /** The newest `auth` that arrived while one was being verified; it replaces any older one. */
  private pendingAuth: { accessToken: string; proof: string } | undefined;
  private helloTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private silenceTimer: NodeJS.Timeout | undefined;
  private expiryTimer: NodeJS.Timeout | undefined;
  private goawayTimer: NodeJS.Timeout | undefined;
  private terminateTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly holder: TunnelHolder,
    private readonly ws: WebSocket,
    readonly shareId: string,
    /** The `htu` every proof on this tunnel must name. */
    private readonly htu: string,
    identity: TunnelIdentity,
  ) {
    this.identity = identity;
    const timings = holder.timings;
    this.closed = new Promise((resolve) => ws.once("close", () => resolve()));
    ws.on("message", (data, isBinary) => this.onMessage(data as Buffer, isBinary));
    ws.on("ping", () => this.received());
    ws.on("pong", () => this.received());
    ws.on("error", (err) => {
      holder.log.warn({ share: shareId, err: err.message }, "a share tunnel's socket failed");
      ws.terminate();
    });
    ws.on("close", (code) => this.onClose(code));
    this.helloTimer = setTimeout(
      () => this.close(TunnelCloseCode.timedOut, `no hello within ${timings.helloTimeoutMs} ms`),
      timings.helloTimeoutMs,
    );
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, timings.pingIntervalMs);
    this.received();
  }

  private get isClosed(): boolean {
    return this.phase === "closed";
  }

  /** Whether the client's last `ports` message announced `port`. */
  servesPort(port: number): boolean {
    return this.ports.has(port);
  }

  /** At its limit of visitor requests in flight. */
  get busy(): boolean {
    return this.inFlight >= this.holder.maxConcurrentRequests;
  }

  /** One visitor stream; `undefined` when the tunnel takes no new one. */
  openStream(headers: OutgoingHttpHeaders): ClientHttp2Stream | undefined {
    const session = this.session;
    if (this.phase !== "open" || session === undefined || session.closed || session.destroyed) return undefined;
    let stream: ClientHttp2Stream;
    try {
      stream = session.request(headers);
    } catch (err) {
      this.holder.log.warn({ share: this.shareId, err: (err as Error).message }, "a visitor stream could not be opened");
      return undefined;
    }
    this.inFlight++;
    stream.once("close", () => {
      this.inFlight--;
      if (this.phase === "draining" && this.inFlight === 0) this.finishDrain();
    });
    return stream;
  }

  /** Another run took the share over: GOAWAY, then `4409` once the last stream
   *  ends or the grace is up. (Not `session.close()`: a gracefully closed session
   *  waits for the client to end the byte stream, which it does not over the tunnel.) */
  supersede(): void {
    if (this.phase !== "open") {
      if (this.phase !== "closed") this.close(TunnelCloseCode.superseded, SUPERSEDED);
      return;
    }
    this.phase = "draining";
    this.holder.superseded(this);
    this.goawayTimer = setTimeout(() => this.finishDrain(), this.holder.timings.goawayGraceMs);
    // GOAWAY; the relay opens no new stream on a draining tunnel, and the ones
    // in flight run on.
    const session = this.session;
    if (session !== undefined && !session.destroyed) session.goaway(constants.NGHTTP2_NO_ERROR);
    if (this.inFlight === 0) this.finishDrain();
  }

  /** The drained tunnel's HTTP/2 connection ends, its GOAWAY written first, then `4409`. */
  private finishDrain(): void {
    if (this.phase !== "draining" || this.drained) return;
    this.drained = true;
    const close = () => this.close(TunnelCloseCode.superseded, SUPERSEDED);
    const session = this.session;
    if (session === undefined || session.destroyed) return close();
    // A destroyed session writes what it holds before it closes.
    session.once("close", close);
    session.destroy();
  }

  /** Closes the tunnel with `code`; its lease is left to lapse. */
  close(code: number, reason: string): void {
    if (this.isClosed) return;
    this.phase = "closed";
    this.clearTimers();
    this.endHttp2();
    this.holder.ended(this, false);
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.ws.terminate();
      return;
    }
    // After a protocol error nothing more is read; otherwise the client's close is.
    if (code === TunnelCloseCode.protocolError) this.ws.pause();
    else if (this.ws.isPaused) this.ws.resume();
    this.ws.close(code, fitCloseReason(reason));
    this.terminateTimer = setTimeout(() => this.ws.terminate(), this.holder.timings.closeGraceMs);
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (this.isClosed) return;
    this.received();
    if (this.phase === "hello") {
      if (isBinary) return this.protocolError("a binary message before hello");
      const reading = readClientControlMessage(data.toString("utf8"));
      if (!reading.ok) return this.protocolError(reading.error);
      if (reading.message.type !== "hello") return this.protocolError(`'${reading.message.type}' before hello`);
      void this.hello(reading.message.epoch);
      return;
    }
    if (this.phase === "connecting") {
      if (!isBinary) {
        const reading = readClientControlMessage(data.toString("utf8"));
        if (reading.ok && reading.message.type === "hello") return this.protocolError("a second hello");
      }
      this.queued.push({ data, isBinary });
      return;
    }
    this.handle(data, isBinary);
  }

  private handle(data: Buffer, isBinary: boolean): void {
    if (this.isClosed) return;
    if (isBinary) {
      this.duplex?.receive(data);
      return;
    }
    const reading = readClientControlMessage(data.toString("utf8"));
    if (!reading.ok) return this.protocolError(reading.error);
    this.control(reading.message);
  }

  private control(message: ClientControlMessage): void {
    switch (message.type) {
      case "hello":
        return this.protocolError("a second hello");
      case "ports":
        this.ports = new Set(message.ports.map((entry) => entry.port));
        return;
      case "auth":
        this.reauthenticate(message.accessToken, message.proof);
        return;
    }
  }

  private async hello(presented: number | null): Promise<void> {
    try {
      await this.connect(presented);
    } finally {
      // Every outcome: a closing tunnel reads the client's close, an open one its messages.
      if (this.phase !== "closed" && this.ws.isPaused && this.duplex?.holding !== true) this.ws.resume();
    }
  }

  private async connect(presented: number | null): Promise<void> {
    this.phase = "connecting";
    // Nothing more is read while the fence is written: the client's messages wait in
    // its socket, not in relay memory. Not silence either (see armSilence).
    this.ws.pause();
    if (this.helloTimer !== undefined) clearTimeout(this.helloTimer);
    this.helloTimer = undefined;
    let result: ConnectShareResult;
    try {
      const share = await this.holder.directory.lookUp(this.shareId);
      if (this.isClosed) return;
      if (share === undefined || !sameOwner(share.owner, this.identity.owner)) {
        return this.close(TunnelCloseCode.shareGone, SHARE_GONE);
      }
      result = await this.holder.directory.connect(this.shareId, presented);
    } catch (err) {
      this.holder.log.error({ share: this.shareId, err: (err as Error).message }, "a share tunnel could not be connected");
      return this.close(1011, "the relay could not reach its share store");
    }
    if (this.isClosed) {
      // The client closed while the fence was written: its lease ends now.
      if (result.kind === "connected" && this.cleanClose) {
        this.holder.release({ id: this.shareId, epoch: result.epoch });
      }
      return;
    }
    switch (result.kind) {
      case "gone":
        return this.close(TunnelCloseCode.shareGone, SHARE_GONE);
      case "superseded":
        return this.close(TunnelCloseCode.superseded, SUPERSEDED);
      case "owner_limit":
        return this.close(TunnelCloseCode.ownerLimit, "the owner is at its connected-share limit");
      case "capacity":
        return this.close(TunnelCloseCode.runnerCapacity, "the runner is at its connected-share capacity");
      case "connected":
        break;
    }
    this.epoch = result.epoch;
    this.phase = "open";
    if (!this.holder.connected(this)) return this.close(TunnelCloseCode.superseded, SUPERSEDED);
    this.holder.log.info({ share: this.shareId, epoch: this.epoch }, "a share tunnel connected");
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeControlMessage({ type: "hello", epoch: this.epoch }));
    this.startHttp2();
    this.armExpiry();
    for (const message of this.queued.splice(0)) this.handle(message.data, message.isBinary);
  }

  private startHttp2(): void {
    const duplex = new TunnelDuplex(this.ws, this.holder.maxBytesPerSecond);
    this.duplex = duplex;
    const session = http2.connect("http://share.invalid", {
      createConnection: () => duplex,
      settings: { enablePush: false },
    });
    this.session = session;
    session.once("remoteSettings", () => {
      if (this.phase === "open") this.holder.routable(this);
    });
    session.on("error", (err: NodeJS.ErrnoException) => {
      // Once the WebSocket is closing, its close decides the outcome.
      if (this.isClosed || this.ws.readyState !== WebSocket.OPEN) return;
      // A GOAWAY the client sent with an error code: the client closes the tunnel.
      if (err.code === "ERR_HTTP2_SESSION_ERROR") return this.awaitClientClose();
      this.protocolError(`HTTP/2: ${err.message}`);
    });
    session.on("goaway", () => {
      if (this.phase === "open") this.awaitClientClose();
    });
    session.on("close", () => {
      if (this.phase === "open") this.awaitClientClose();
    });
  }

  /** The client ended the HTTP/2 connection; it closes the tunnel, or the grace does. */
  private awaitClientClose(): void {
    if (this.goawayTimer !== undefined) return;
    this.holder.unroutable(this);
    this.goawayTimer = setTimeout(
      () => this.close(1000, "the HTTP/2 connection ended"),
      this.holder.timings.goawayGraceMs,
    );
  }

  /** One verification runs at a time and one `auth` waits: the newest token is all the relay keeps. */
  private reauthenticate(accessToken: string, proof: string): void {
    this.pendingAuth = { accessToken, proof };
    if (this.authenticating) return;
    this.authenticating = true;
    void (async () => {
      try {
        for (let next = this.pendingAuth; next !== undefined; next = this.pendingAuth) {
          this.pendingAuth = undefined;
          await this.verifyAuth(next.accessToken, next.proof);
        }
      } finally {
        this.authenticating = false;
      }
    })();
  }

  private async verifyAuth(accessToken: string, proof: string): Promise<void> {
    if (this.isClosed) return;
    let identity: TunnelIdentity;
    try {
      identity = await this.holder.authenticator.authenticate({ accessToken, proof }, this.htu);
    } catch (err) {
      if (err instanceof IdentityRefusal) return this.close(TunnelCloseCode.credentialRefused, err.message);
      if (err instanceof IdentityProviderUnavailable) {
        this.holder.log.warn(
          { share: this.shareId, issuer: err.issuer, err: err.message },
          "a share tunnel's renewed credential could not be verified; the tunnel keeps its current token",
        );
        return;
      }
      this.holder.log.error({ share: this.shareId, err: (err as Error).message }, "a share tunnel's credential could not be verified");
      return this.close(1011, "the relay could not verify the credential");
    }
    if (this.isClosed) return;
    if (!sameOwner(identity.owner, this.identity.owner)) {
      return this.close(TunnelCloseCode.credentialRefused, "the renewed credential is another owner's");
    }
    this.identity = identity;
    this.armExpiry();
  }

  /** Closes `4401` when the newest token the relay holds expires. */
  private armExpiry(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    const left = this.identity.expiresAt.getTime() - Date.now();
    // setTimeout holds at most 2^31 - 1 ms; a longer token is re-armed.
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = undefined;
        if (this.identity.expiresAt.getTime() > Date.now()) this.armExpiry();
        else this.close(TunnelCloseCode.credentialRefused, "the newest access token expired");
      },
      Math.max(0, Math.min(left, 2 ** 31 - 1)),
    );
  }

  private received(): void {
    this.lastReceivedAt = Date.now();
    if (this.silenceTimer === undefined && this.phase !== "closed") this.armSilence(this.holder.timings.silenceMs);
  }

  private armSilence(ms: number): void {
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = undefined;
      const silenceMs = this.holder.timings.silenceMs;
      // While the relay holds the socket paused (the fence, the byte rate, a slow
      // visitor), the client's bytes wait on the relay: that is not silence.
      if (this.phase === "connecting" || this.duplex?.holding === true) this.lastReceivedAt = Date.now();
      const quiet = Date.now() - this.lastReceivedAt;
      if (quiet >= silenceMs) this.close(TunnelCloseCode.timedOut, `nothing received for ${silenceMs} ms`);
      else this.armSilence(silenceMs - quiet);
    }, ms);
  }

  private protocolError(detail: string): void {
    this.close(TunnelCloseCode.protocolError, detail);
  }

  private onClose(code: number): void {
    if (this.terminateTimer !== undefined) clearTimeout(this.terminateTimer);
    this.duplex?.receiveEnd();
    if (this.isClosed) return;
    this.phase = "closed";
    this.cleanClose = code === 1000 || code === 1001;
    this.clearTimers();
    this.endHttp2();
    this.holder.ended(this, this.cleanClose);
  }

  private endHttp2(): void {
    const session = this.session;
    if (session !== undefined && !session.destroyed) session.destroy();
    if (this.duplex !== undefined && !this.duplex.destroyed) this.duplex.destroy();
  }

  private clearTimers(): void {
    for (const timer of [this.helloTimer, this.silenceTimer, this.expiryTimer, this.goawayTimer]) {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    this.helloTimer = this.silenceTimer = this.expiryTimer = this.goawayTimer = this.pingTimer = undefined;
  }
}

export function sameOwner(a: ShareOwner, b: ShareOwner): boolean {
  return a.iss === b.iss && a.sub === b.sub;
}

/** A close frame's reason holds at most 123 bytes. */
export function fitCloseReason(text: string): string {
  let reason = text;
  while (Buffer.byteLength(reason, "utf8") > 123) reason = reason.slice(0, -1);
  return reason;
}
