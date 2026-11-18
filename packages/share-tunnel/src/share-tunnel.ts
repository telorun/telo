// The client engine: one tunnel per `telo run --share` invocation, reconnecting
// through every close that does not end the run, forwarding the relay's HTTP/2
// streams to local ports.

import http from "node:http";
import http2 from "node:http2";
import type { IncomingMessage } from "node:http";

import { WebSocket } from "ws";

import { classifyTunnelClose, type ShareLostReason, type ShareTunnelWarningReason } from "./close-classification.js";
import {
  assertSharePorts,
  encodeControlMessage,
  readRelayControlMessage,
  type ClientControlMessage,
  type SharePort,
} from "./control-messages.js";
import { forwardShareStream } from "./local-forwarding.js";
import { MessageSizeGuard } from "./message-size-guard.js";
import type { RunnerCredential, RunnerCredentialAnswer, RunnerCredentialProvider } from "./runner-credential.js";
import {
  TUNNEL_BINARY_MESSAGE_MAX_BYTES,
  TUNNEL_REAUTH_MIN_LEAD_MS,
  TUNNEL_SILENCE_MS,
  TUNNEL_SUBPROTOCOLS_OFFERED,
  TUNNEL_TEXT_MESSAGE_MAX_BYTES,
  TunnelCloseCode,
  tunnelProofUrl,
} from "./tunnel-protocol.js";
import { WebSocketDuplex } from "./websocket-duplex.js";

/** The engine's clocks. The defaults are the protocol's; only a test shortens them. */
export interface ShareTunnelTimings {
  /** Receiving nothing for this long closes `4408` and reconnects. */
  silenceMs: number;
  /** How long before the presented token's expiry `auth` is sent. At least 60 s outside tests. */
  reauthLeadMs: number;
  /** The least remaining lifetime asked of the credential provider; above `reauthLeadMs`. */
  credentialMinLifetimeMs: number;
  /** The first reconnect delay; each failed attempt doubles it. */
  backoffInitialMs: number;
  /** The reconnect delay's cap. */
  backoffMaxMs: number;
  /** How long the upgrade may take. */
  upgradeTimeoutMs: number;
  /** How long a closing handshake may take before the socket is dropped. */
  closeGraceMs: number;
  /** How long the relay has to close the tunnel after its HTTP/2 connection ended. */
  http2EndGraceMs: number;
}

export const DEFAULT_SHARE_TUNNEL_TIMINGS: Readonly<ShareTunnelTimings> = {
  silenceMs: TUNNEL_SILENCE_MS,
  reauthLeadMs: 2 * TUNNEL_REAUTH_MIN_LEAD_MS,
  credentialMinLifetimeMs: 3 * TUNNEL_REAUTH_MIN_LEAD_MS,
  backoffInitialMs: 1_000,
  backoffMaxMs: 30_000,
  upgradeTimeoutMs: 30_000,
  closeGraceMs: 2_000,
  http2EndGraceMs: 15_000,
};

export interface ShareTunnelOptions {
  /** The share's `tunnelUrl`, as `POST /v1/shares` answered it. */
  tunnelUrl: string;
  /** The runner the share was taken from: what credentials are asked for. */
  runnerUrl: string;
  credentials: RunnerCredentialProvider;
  /** The `tcp` ports to route, when known at start; `setPorts` replaces them. */
  ports?: readonly SharePort[];
  onEvent?: (event: ShareTunnelEvent) => void;
  timings?: Partial<ShareTunnelTimings>;
}

export interface ShareTunnelWarning {
  reason: ShareTunnelWarningReason;
  /** The relay's close text, the provider's message, or the error that ended the attempt; may be empty. */
  detail: string;
  /** The close code, when a close caused the warning. */
  code?: number;
  /** For `sign-in-required`: what the user runs. */
  command?: string;
}

export type ShareTunnelEvent =
  /** A connect completed its handshake; `reconnect` is false on the run's first. */
  | { type: "connected"; epoch: number; reconnect: boolean; afterWarning: boolean }
  /** `auth` presented a renewed token. */
  | { type: "renewed"; afterWarning: boolean }
  /** A visitor stream could not be forwarded: the local port refused, broke, or did not speak HTTP. */
  | { type: "forward-failed"; port: number; message: string }
  /** The local port answered a stream again after a `forward-failed`; emitted once per failed port. */
  | { type: "forward-recovered"; port: number }
  /** Emitted once per distinct reason until a connect (or a renewal) succeeds. */
  | ({ type: "warning" } & ShareTunnelWarning);

export type ShareTunnelEnding =
  /** `close()` ended it. */
  | { outcome: "closed" }
  /** The share no longer reaches this run, and cannot again. */
  | { outcome: "lost"; reason: ShareLostReason; code: number; detail: string }
  /** The relay speaks no generation this client offers. */
  | {
      outcome: "runner-unsupported";
      offered: readonly string[];
      cause: "no-subprotocol" | "protocol-error";
      detail: string;
    };

export interface ShareTunnel {
  /** Replaces the announced ports, sending them at once when connected; never reconnects. */
  setPorts(ports: readonly SharePort[]): void;
  /** Closes the tunnel cleanly and resolves once it has ended. */
  close(): Promise<void>;
  /**
   * Resolves with how the tunnel ended. Rejects only when the credential
   * provider breaks its contract by rejecting.
   */
  readonly ended: Promise<ShareTunnelEnding>;
}

/** Starts the tunnel; it connects in the background. */
export function startShareTunnel(options: ShareTunnelOptions): ShareTunnel {
  return new ShareTunnelEngine(options);
}

type LocalClose =
  | { kind: "stop" }
  | { kind: "protocol"; detail: string }
  | { kind: "silence" }
  | { kind: "http2-ended" };

type AttemptResult =
  | { kind: "ended"; ending: ShareTunnelEnding }
  | { kind: "retry"; handshook: boolean; warning?: ShareTunnelWarning };

class ShareTunnelEngine implements ShareTunnel {
  readonly ended: Promise<ShareTunnelEnding>;
  readonly timings: ShareTunnelTimings;
  readonly proofUrl: string;
  readonly agent = new http.Agent({ keepAlive: true });
  private readonly failedPorts = new Set<number>();
  readonly forwardFailed = (port: number, message: string): void => {
    this.failedPorts.add(port);
    this.options.onEvent?.({ type: "forward-failed", port, message });
  };
  readonly forwardAnswered = (port: number): void => {
    if (this.failedPorts.delete(port)) this.options.onEvent?.({ type: "forward-recovered", port });
  };
  ports: SharePort[] | undefined;
  epoch: number | null = null;

  private readonly stop = new AbortController();
  private readonly finished: Promise<void>;
  private readonly warned = new Set<string>();
  private warnedSinceSuccess = false;
  private connectedBefore = false;
  private current: TunnelConnection | undefined;

  constructor(readonly options: ShareTunnelOptions) {
    this.timings = { ...DEFAULT_SHARE_TUNNEL_TIMINGS, ...options.timings };
    this.proofUrl = tunnelProofUrl(options.tunnelUrl);
    if (options.ports !== undefined) {
      assertSharePorts(options.ports);
      this.ports = options.ports.map((port) => ({ ...port }));
    }
    this.ended = this.run().finally(() => {
      this.stop.abort();
      this.current?.closeLocally({ kind: "stop" });
      this.agent.destroy();
    });
    this.finished = this.ended.then(
      () => undefined,
      () => undefined,
    );
  }

  get stopping(): boolean {
    return this.stop.signal.aborted;
  }

  setPorts(ports: readonly SharePort[]): void {
    assertSharePorts(ports);
    this.ports = ports.map((port) => ({ ...port }));
    this.current?.announcePorts();
  }

  async close(): Promise<void> {
    this.stop.abort();
    this.current?.closeLocally({ kind: "stop" });
    await this.finished;
  }

  isAnnounced(port: number): boolean {
    return this.ports?.some((entry) => entry.port === port) ?? false;
  }

  /** Asks the provider once; `undefined` when the tunnel stopped meanwhile. */
  async askCredential(signal: AbortSignal): Promise<RunnerCredentialAnswer | undefined> {
    try {
      return await this.options.credentials.credential({
        runnerUrl: this.options.runnerUrl,
        minLifetimeMs: this.timings.credentialMinLifetimeMs,
        signal,
      });
    } catch (err) {
      if (signal.aborted) return undefined;
      throw err;
    }
  }

  warn(warning: ShareTunnelWarning): void {
    const key = [warning.reason, warning.code ?? "", warning.detail, warning.command ?? ""].join("\u0000");
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warnedSinceSuccess = true;
    this.options.onEvent?.({ type: "warning", ...warning });
  }

  warnCredential(answer: Exclude<RunnerCredentialAnswer, { outcome: "credential" }>): void {
    if (answer.outcome === "sign-in-required") {
      this.warn({ reason: "sign-in-required", detail: "", command: answer.command });
    } else {
      this.warn({ reason: "credential-unavailable", detail: answer.message });
    }
  }

  connected(epoch: number): void {
    const afterWarning = this.succeeded();
    this.options.onEvent?.({ type: "connected", epoch, reconnect: this.connectedBefore, afterWarning });
    this.connectedBefore = true;
  }

  renewed(): void {
    this.options.onEvent?.({ type: "renewed", afterWarning: this.succeeded() });
  }

  backoff(failures: number): number {
    const ceiling = Math.min(this.timings.backoffMaxMs, this.timings.backoffInitialMs * 2 ** Math.min(failures, 30));
    return ceiling / 2 + Math.random() * (ceiling / 2);
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
    });
  }

  private succeeded(): boolean {
    const afterWarning = this.warnedSinceSuccess;
    this.warned.clear();
    this.warnedSinceSuccess = false;
    return afterWarning;
  }

  private async run(): Promise<ShareTunnelEnding> {
    let failures = 0;
    while (!this.stopping) {
      const answer = await this.askCredential(this.stop.signal);
      if (answer === undefined || this.stopping) break;
      if (answer.outcome === "credential") {
        const result = await this.attempt(answer.credential);
        if (result.kind === "ended") return result.ending;
        if (result.handshook) failures = 0;
        if (this.stopping) break;
        if (result.warning !== undefined) this.warn(result.warning);
      } else {
        this.warnCredential(answer);
      }
      await this.sleep(this.backoff(failures++), this.stop.signal);
    }
    return { outcome: "closed" };
  }

  private async attempt(credential: RunnerCredential): Promise<AttemptResult> {
    const proof = await credential.proof({ htm: "GET", htu: this.proofUrl });
    if (this.stopping) return { kind: "retry", handshook: false };
    const connection = new TunnelConnection(this, credential, proof);
    this.current = connection;
    try {
      return await connection.done;
    } finally {
      this.current = undefined;
    }
  }
}

/** One WebSocket to the relay, from upgrade to close. */
class TunnelConnection {
  readonly done: Promise<AttemptResult>;

  private readonly ws: WebSocket;
  private readonly abort = new AbortController();
  private readonly presentedEpoch: number | null;
  private presented: RunnerCredential;
  private settle!: (result: AttemptResult) => void;
  private fail!: (error: unknown) => void;
  private opened = false;
  private handshook = false;
  private closed = false;
  private selectedSubprotocol: string | null | undefined;
  private localClose: LocalClose | undefined;
  private lastError: Error | undefined;
  private duplex: WebSocketDuplex | undefined;
  private session: http2.ServerHttp2Session | undefined;
  private lastReceivedAt = Date.now();
  private silenceTimer: NodeJS.Timeout | undefined;
  private reauthTimer: NodeJS.Timeout | undefined;
  private http2EndTimer: NodeJS.Timeout | undefined;
  private terminateTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly engine: ShareTunnelEngine,
    credential: RunnerCredential,
    proof: string,
  ) {
    this.presented = credential;
    this.presentedEpoch = engine.epoch;
    this.done = new Promise<AttemptResult>((resolve, reject) => {
      this.settle = resolve;
      this.fail = reject;
    });
    this.ws = new WebSocket(engine.options.tunnelUrl, [...TUNNEL_SUBPROTOCOLS_OFFERED], {
      headers: { Authorization: `DPoP ${credential.accessToken}`, DPoP: proof },
      perMessageDeflate: false,
      maxPayload: 0,
      handshakeTimeout: engine.timings.upgradeTimeoutMs,
      followRedirects: false,
    });
    this.ws.on("upgrade", (res) => this.onUpgrade(res));
    this.ws.on("open", () => this.onOpen());
    this.ws.on("message", (data, isBinary) => this.onMessage(data as Buffer, isBinary));
    this.ws.on("ping", () => this.received());
    this.ws.on("pong", () => this.received());
    this.ws.on("error", (err) => {
      this.lastError = err;
    });
    this.ws.on("close", (code, reason) => this.onClose(code, reason.toString()));
  }

  announcePorts(): void {
    const ports = this.engine.ports;
    if (!this.handshook || this.closed || ports === undefined) return;
    this.send({ type: "ports", ports });
  }

  closeLocally(close: LocalClose): void {
    if (this.closed) return;
    this.localClose ??= close;
    this.clearTimers();
    this.abort.abort();
    this.endHttp2();
    if (this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.terminate();
      return;
    }
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (close.kind === "protocol") this.ws.pause();
    this.ws.close(...closeFrame(close));
    this.terminateTimer = setTimeout(() => this.ws.terminate(), this.engine.timings.closeGraceMs);
  }

  private onUpgrade(res: IncomingMessage): void {
    const selected = res.headers["sec-websocket-protocol"];
    this.selectedSubprotocol = typeof selected === "string" ? selected : null;
    const guard = new MessageSizeGuard(
      { textBytes: TUNNEL_TEXT_MESSAGE_MAX_BYTES, binaryBytes: TUNNEL_BINARY_MESSAGE_MAX_BYTES },
      (oversize) =>
        this.closeLocally({
          kind: "protocol",
          detail: `a ${oversize.kind} message over ${oversize.limit} bytes`,
        }),
    );
    res.socket.on("data", (chunk: Buffer) => guard.write(chunk));
  }

  private onOpen(): void {
    this.opened = true;
    if (this.engine.stopping) {
      this.closeLocally({ kind: "stop" });
      return;
    }
    this.received();
    this.send({ type: "hello", epoch: this.presentedEpoch });
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (this.closed || this.localClose !== undefined) return;
    this.received();
    if (isBinary) {
      if (!this.handshook) {
        this.closeLocally({ kind: "protocol", detail: "a binary message before the relay's hello" });
        return;
      }
      this.duplex?.receive(data);
      return;
    }
    const reading = readRelayControlMessage(data.toString("utf8"));
    if (!reading.ok) {
      this.closeLocally({ kind: "protocol", detail: reading.error });
      return;
    }
    if (this.handshook) {
      this.closeLocally({ kind: "protocol", detail: "a second hello" });
      return;
    }
    const { epoch } = reading.message;
    if (this.presentedEpoch !== null && epoch !== this.presentedEpoch) {
      this.closeLocally({
        kind: "protocol",
        detail: `the relay answered epoch ${epoch} to a hello presenting ${this.presentedEpoch}`,
      });
      return;
    }
    this.handshook = true;
    this.engine.epoch = epoch;
    this.engine.connected(epoch);
    this.announcePorts();
    this.startHttp2();
    this.scheduleReauth();
  }

  private onClose(code: number, reason: string): void {
    this.closed = true;
    this.clearTimers();
    if (this.terminateTimer !== undefined) clearTimeout(this.terminateTimer);
    this.abort.abort();
    this.duplex?.receiveEnd();
    this.endHttp2();
    this.settle(this.result(code, reason));
  }

  private result(code: number, reason: string): AttemptResult {
    const handshook = this.handshook;
    const local = this.localClose;
    if (local?.kind === "stop") return { kind: "retry", handshook };
    if (code === TunnelCloseCode.shareGone || code === TunnelCloseCode.superseded) {
      const closeClass = classifyTunnelClose(code);
      if (closeClass.outcome === "lost") {
        return { kind: "ended", ending: { outcome: "lost", reason: closeClass.reason, code, detail: reason } };
      }
    }
    if (this.selectedSubprotocol !== undefined && !TUNNEL_SUBPROTOCOLS_OFFERED.includes(this.selectedSubprotocol ?? "")) {
      return {
        kind: "ended",
        ending: {
          outcome: "runner-unsupported",
          offered: TUNNEL_SUBPROTOCOLS_OFFERED,
          cause: "no-subprotocol",
          detail:
            this.selectedSubprotocol === null
              ? "the relay selected no subprotocol"
              : `the relay selected '${this.selectedSubprotocol}', which was not offered`,
        },
      };
    }
    if (local?.kind === "protocol") {
      return {
        kind: "ended",
        ending: { outcome: "runner-unsupported", offered: TUNNEL_SUBPROTOCOLS_OFFERED, cause: "protocol-error", detail: local.detail },
      };
    }
    if (local?.kind === "silence") {
      return {
        kind: "retry",
        handshook,
        warning: { reason: "timed-out", code: TunnelCloseCode.timedOut, detail: `nothing received for ${this.engine.timings.silenceMs} ms` },
      };
    }
    if (local?.kind === "http2-ended") {
      return {
        kind: "retry",
        handshook,
        warning: { reason: "disconnected", detail: "the relay ended the HTTP/2 connection without closing the tunnel" },
      };
    }
    if (!this.opened) {
      return { kind: "retry", handshook, warning: { reason: "unreachable", detail: this.lastError?.message ?? "" } };
    }
    const closeClass = classifyTunnelClose(code);
    if (closeClass.outcome === "runner-unsupported") {
      return {
        kind: "ended",
        ending: { outcome: "runner-unsupported", offered: TUNNEL_SUBPROTOCOLS_OFFERED, cause: "protocol-error", detail: reason },
      };
    }
    if (closeClass.outcome === "lost") {
      return { kind: "ended", ending: { outcome: "lost", reason: closeClass.reason, code, detail: reason } };
    }
    const detail = reason !== "" ? reason : (this.lastError?.message ?? "");
    return { kind: "retry", handshook, warning: { reason: closeClass.warning, code, detail } };
  }

  private send(message: ClientControlMessage): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeControlMessage(message));
  }

  private received(): void {
    this.lastReceivedAt = Date.now();
    if (this.silenceTimer === undefined && !this.closed) this.armSilence(this.engine.timings.silenceMs);
  }

  private armSilence(ms: number): void {
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = undefined;
      const quiet = Date.now() - this.lastReceivedAt;
      if (quiet >= this.engine.timings.silenceMs) this.closeLocally({ kind: "silence" });
      else this.armSilence(this.engine.timings.silenceMs - quiet);
    }, ms);
  }

  private startHttp2(): void {
    const duplex = new WebSocketDuplex(this.ws);
    this.duplex = duplex;
    const session = http2.performServerHandshake(duplex, { settings: { enableConnectProtocol: true } });
    this.session = session;
    session.on("stream", (stream, headers) => forwardShareStream(stream, headers, this.engine));
    session.on("error", (err: Error) => {
      // Once the WebSocket is closing, its close decides the outcome.
      if (this.closed || this.localClose !== undefined || this.ws.readyState !== WebSocket.OPEN) return;
      // A GOAWAY the relay sent with an error code: the relay closes the tunnel itself.
      if ((err as NodeJS.ErrnoException).code === "ERR_HTTP2_SESSION_ERROR") return;
      this.closeLocally({ kind: "protocol", detail: `HTTP/2: ${err.message}` });
    });
    session.on("close", () => {
      if (this.closed || this.localClose !== undefined || this.ws.readyState !== WebSocket.OPEN) return;
      this.http2EndTimer = setTimeout(
        () => this.closeLocally({ kind: "http2-ended" }),
        this.engine.timings.http2EndGraceMs,
      );
    });
  }

  private endHttp2(): void {
    const session = this.session;
    this.session = undefined;
    if (session !== undefined && !session.destroyed) session.destroy();
    if (this.duplex !== undefined && !this.duplex.destroyed) this.duplex.destroy();
  }

  private scheduleReauth(): void {
    // `reauthLeadMs` before expiry; a token too short for that, at least the protocol's
    // minimum lead before; one too short even for that, halfway, so renewals never spin.
    const remaining = this.presented.expiresAt.getTime() - Date.now();
    const lead = this.engine.timings.reauthLeadMs;
    const minimumLead = Math.min(lead, TUNNEL_REAUTH_MIN_LEAD_MS);
    const delay =
      remaining > lead ? remaining - lead : remaining > minimumLead ? remaining - minimumLead : Math.max(0, remaining / 2);
    // setTimeout holds at most 2^31 - 1 ms; a longer wait is re-armed when the clamped timer fires early.
    this.reauthTimer = setTimeout(
      () => {
        this.reauthTimer = undefined;
        if (delay > MAX_TIMER_MS) this.scheduleReauth();
        else this.reauth(0);
      },
      Math.min(delay, MAX_TIMER_MS),
    );
  }

  private reauth(failures: number): void {
    this.reauthTimer = undefined;
    this.renew(failures).catch((err: unknown) => {
      this.closeLocally({ kind: "stop" });
      this.fail(err);
    });
  }

  private async renew(failures: number): Promise<void> {
    const answer = await this.engine.askCredential(this.abort.signal);
    if (answer === undefined || this.closed || this.localClose !== undefined) return;
    if (answer.outcome !== "credential") {
      this.engine.warnCredential(answer);
      this.reauthTimer = setTimeout(() => this.reauth(failures + 1), this.engine.backoff(failures));
      return;
    }
    const proof = await answer.credential.proof({ htm: "GET", htu: this.engine.proofUrl });
    if (this.closed || this.localClose !== undefined) return;
    this.send({ type: "auth", accessToken: answer.credential.accessToken, proof });
    this.presented = answer.credential;
    this.engine.renewed();
    this.scheduleReauth();
  }

  private clearTimers(): void {
    for (const timer of [this.silenceTimer, this.reauthTimer, this.http2EndTimer]) {
      if (timer !== undefined) clearTimeout(timer);
    }
    this.silenceTimer = this.reauthTimer = this.http2EndTimer = undefined;
  }
}

const MAX_TIMER_MS = 2 ** 31 - 1;

/** The close frame for a close the client starts; its reason fits the 123 bytes a close frame holds. */
function closeFrame(close: LocalClose): [number, string] {
  switch (close.kind) {
    case "stop":
      return [1000, "the run ended"];
    case "protocol":
      return [TunnelCloseCode.protocolError, fitCloseReason(close.detail)];
    case "silence":
      return [TunnelCloseCode.timedOut, "nothing received from the relay"];
    case "http2-ended":
      return [1000, "the HTTP/2 connection ended"];
  }
}

function fitCloseReason(text: string): string {
  let reason = text;
  while (Buffer.byteLength(reason, "utf8") > 123) reason = reason.slice(0, -1);
  return reason;
}
