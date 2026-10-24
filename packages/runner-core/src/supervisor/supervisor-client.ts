import WebSocket from "ws";

import { AppRunRefused, type AppRun } from "../backend.js";
import type { ByteStreamTag } from "../contract.js";
import {
  SUPERVISOR_CLOSE,
  SUPERVISOR_GENERATION,
  SUPERVISOR_PATH,
  SupervisorGenerationMismatch,
  decodeOutputFrame,
  decodeSupervisorMessage,
  encodeRunnerMessage,
  type RunnerMessage,
  type SupervisorHello,
  type SupervisorMessage,
} from "./supervisor-protocol.js";

/** Why a client stopped for good. Each is a fact about the pod, not the run:
 *  - `generation_mismatch` — the supervisor speaks another generation; the pod
 *    predates this runner build and is recreated;
 *  - `unauthorized` — the supervisor refused the token (`4401` / `4403`);
 *  - `superseded` — another connection took this supervisor over;
 *  - `protocol_error` — one side sent what the protocol does not define;
 *  - `restarted` — the supervisor is another process than the one this client
 *    knew, so the container restarted and its run is gone. */
export type SupervisorTermination =
  | { kind: "generation_mismatch"; message: string }
  | { kind: "unauthorized"; code: number; message: string }
  | { kind: "superseded"; message: string }
  | { kind: "protocol_error"; message: string }
  | { kind: "restarted"; message: string };

export interface SupervisorRunEnding {
  runId: string;
  code?: number;
  signal?: string;
}

export interface SupervisorListener {
  /** Every `hello`, the first and each reconnect's. */
  onConnected(hello: SupervisorHello): void;
  onStarted(runId: string): void;
  /** Once per run, however often the supervisor repeats it. */
  onExited(ending: SupervisorRunEnding): void;
  /** A spawn that never ran; once per run. */
  onFailed(runId: string, reason: string): void;
  onRefused(runId: string, code: "run_active" | "no_run"): void;
  onOutput(chunk: Buffer, stream: ByteStreamTag, seq: number): void;
  /** Frames `expected` … `received - 1` left the supervisor's ring before this
   *  client read them. */
  onGap(expected: number, received: number): void;
  /** The connection dropped; the client reconnects and is replayed. */
  onDisconnected(reason: string): void;
  onTerminated(termination: SupervisorTermination): void;
}

export interface SupervisorClientOptions {
  /** The app container's address as the runner reaches it. */
  host: string;
  port: number;
  /** The container's `TELO_SUPERVISOR_TOKEN`. */
  token: string;
  listener: SupervisorListener;
  reconnectDelayMs?: { initial: number; max: number };
}

export class SupervisorTerminated extends Error {
  constructor(public readonly termination: SupervisorTermination) {
    super(`supervisor connection ended for good (${termination.kind}): ${termination.message}`);
    this.name = "SupervisorTerminated";
  }
}

/** A spawn the supervisor reported as never having run. */
export class SupervisorRunFailed extends Error {
  constructor(
    public readonly runId: string,
    public readonly reason: string,
  ) {
    super(reason);
    this.name = "SupervisorRunFailed";
  }
}

const STOP_QUERY_GRACE_MS = 0;

interface PendingRun {
  run: AppRun;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PendingStop {
  runId: string;
  graceMs: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * The runner's connection to one app container's session supervisor. It keeps
 * reconnecting until `close()` or a termination, resuming each time from the
 * last output seq it holds, and settles every request across reconnects by the
 * protocol's idempotency: a `run` is re-sent until answered, and a run that was
 * live when the connection dropped is asked for its ending with `stop`, which
 * answers the ending once it has ended and stops nothing that has not.
 */
export class SupervisorClient {
  private socket: WebSocket | undefined;
  private ready = false;
  private closed = false;
  private termination: SupervisorTermination | undefined;
  private instance: string | undefined;
  private hello: SupervisorHello | undefined;
  private live: string | undefined;
  private lastStarted: string | undefined;
  private lastEnded: string | undefined;
  private seq: number;
  private delay: number;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly pendingRuns = new Map<string, PendingRun>();
  private readonly pendingStops: PendingStop[] = [];
  private readonly connectWaiters: Array<{
    resolve: (hello: SupervisorHello) => void;
    reject: (error: Error) => void;
  }> = [];
  private readonly reconnect: { initial: number; max: number };

  constructor(private readonly options: SupervisorClientOptions) {
    this.seq = 0;
    this.reconnect = options.reconnectDelayMs ?? { initial: 200, max: 5_000 };
    this.delay = this.reconnect.initial;
  }

  /** The run the supervisor last reported live. */
  get liveRunId(): string | undefined {
    return this.live;
  }

  /** The last output seq received. */
  get lastSeq(): number {
    return this.seq;
  }

  /** Starts connecting; resolves with the first `hello`. Rejects with
   *  `SupervisorTerminated` on a termination, or when closed first. */
  connect(): Promise<SupervisorHello> {
    const answered = new Promise<SupervisorHello>((resolve, reject) => {
      this.connectWaiters.push({ resolve, reject });
    });
    if (this.termination) {
      this.settleConnect(new SupervisorTerminated(this.termination));
    } else if (this.ready && this.hello) {
      this.settleConnect(undefined, this.hello);
    } else if (this.closed) {
      this.settleConnect(new Error("the supervisor client is closed"));
    } else {
      this.ensureDialing();
    }
    return answered;
  }

  /** Resolves once the supervisor reports the run started — or already ended,
   *  which `onExited` reports. Rejects with `AppRunRefused("run_active")` while
   *  another run is live, `SupervisorRunFailed` for a spawn that never ran, and
   *  `SupervisorTerminated` when the connection ends for good. */
  run(run: AppRun): Promise<void> {
    const failure = this.unusable();
    if (failure) return Promise.reject(failure);
    // Validated here, so a malformed run is the caller's error and never a close.
    const message = this.runMessage(run);
    encodeRunnerMessage(message);
    return new Promise<void>((resolve, reject) => {
      this.pendingRuns.set(run.runId, { run, resolve, reject });
      if (this.ready) this.send(message);
      else this.ensureDialing();
    });
  }

  /** SIGTERM to the run's group, SIGKILL after `graceMs`. Resolves once asked;
   *  the ending arrives through `onExited`. A run that is not live is a no-op. */
  stop(runId: string, graceMs: number): Promise<void> {
    const failure = this.unusable();
    if (failure) return Promise.reject(failure);
    encodeRunnerMessage({ type: "stop", runId, graceMs });
    if (this.ready) {
      this.send({ type: "stop", runId, graceMs });
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.pendingStops.push({ runId, graceMs, resolve, reject });
      this.ensureDialing();
    });
  }

  /** Dropped unless `runId` is the live run and the connection is up. */
  writeStdin(runId: string, bytes: Uint8Array): void {
    if (!this.ready || this.live !== runId || !this.socket) return;
    // A send that fails is the connection failing, which its `close` reports.
    this.socket.send(bytes, { binary: true });
  }

  /** Dropped unless `runId` is the live run and the connection is up. */
  resize(runId: string, cols: number, rows: number): void {
    if (!this.ready || this.live !== runId) return;
    this.send({ type: "resize", cols, rows });
  }

  /** Ends the connection and stops reconnecting; the run, if any, keeps
   *  running. Pending requests reject. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.rejectPending(new Error("the supervisor client was closed"));
    const socket = this.socket;
    this.socket = undefined;
    this.ready = false;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close(1000, "runner detached");
    });
  }

  private unusable(): Error | undefined {
    if (this.termination) return new SupervisorTerminated(this.termination);
    if (this.closed) return new Error("the supervisor client is closed");
    return undefined;
  }

  private ensureDialing(): void {
    if (!this.socket && !this.reconnectTimer) this.dial();
  }

  private runMessage(run: AppRun): RunnerMessage {
    return {
      type: "run",
      runId: run.runId,
      argv: run.argv,
      env: run.env,
      cwd: run.cwd,
      io: run.io,
      ...(run.cols !== undefined ? { cols: run.cols } : {}),
      ...(run.rows !== undefined ? { rows: run.rows } : {}),
    };
  }

  private dial(): void {
    this.reconnectTimer = undefined;
    const { host, port, token } = this.options;
    const authority = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
    const socket = new WebSocket(`ws://${authority}${SUPERVISOR_PATH}`, {
      headers: { authorization: `Bearer ${token}` },
      perMessageDeflate: false,
      handshakeTimeout: 10_000,
    });
    this.socket = socket;
    let failure: string | undefined;
    socket.on("open", () => {
      this.send({ type: "hello", generation: SUPERVISOR_GENERATION, lastSeq: this.seq }, socket);
    });
    socket.on("message", (data, isBinary) => {
      if (this.socket !== socket) return;
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (isBinary) this.onFrame(bytes);
      else this.onText(bytes.toString("utf8"));
    });
    socket.on("error", (error) => {
      failure = error.message;
    });
    socket.on("close", (code, reason) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.ready = false;
      this.onClose(code, reason.toString("utf8") || failure || "connection closed");
    });
  }

  private onClose(code: number, reason: string): void {
    if (this.closed || this.termination) return;
    switch (code) {
      case SUPERVISOR_CLOSE.tokenMissing:
      case SUPERVISOR_CLOSE.tokenInvalid:
        return this.terminate({ kind: "unauthorized", code, message: reason });
      case SUPERVISOR_CLOSE.generationMismatch:
        return this.terminate({ kind: "generation_mismatch", message: reason });
      case SUPERVISOR_CLOSE.superseded:
        return this.terminate({ kind: "superseded", message: reason });
      case SUPERVISOR_CLOSE.protocolError:
        return this.terminate({ kind: "protocol_error", message: `the supervisor refused a message: ${reason}` });
    }
    this.options.listener.onDisconnected(`${code}: ${reason}`);
    this.reconnectTimer = setTimeout(() => this.dial(), this.delay);
    this.delay = Math.min(this.delay * 2, this.reconnect.max);
  }

  private onText(text: string): void {
    let message: SupervisorMessage;
    try {
      message = decodeSupervisorMessage(text);
    } catch (error) {
      if (error instanceof SupervisorGenerationMismatch) {
        this.abandon(SUPERVISOR_CLOSE.generationMismatch, { kind: "generation_mismatch", message: error.message });
      } else {
        this.abandon(SUPERVISOR_CLOSE.protocolError, {
          kind: "protocol_error",
          message: `the supervisor sent ${JSON.stringify(text.slice(0, 200))}: ${(error as Error).message}`,
        });
      }
      return;
    }
    if (!this.ready && message.type !== "hello") {
      this.abandon(SUPERVISOR_CLOSE.protocolError, {
        kind: "protocol_error",
        message: `the supervisor sent '${message.type}' before hello`,
      });
      return;
    }
    switch (message.type) {
      case "hello":
        return this.onHello(message);
      case "started":
        return this.onStarted(message.runId);
      case "exited": {
        const ending: SupervisorRunEnding =
          "code" in message ? { runId: message.runId, code: message.code } : { runId: message.runId, signal: message.signal };
        return this.onEnded(ending);
      }
      case "failed":
        return this.onFailed(message.runId, message.reason);
      case "refused":
        return this.onRefused(message.runId, message.code);
    }
  }

  private onHello(hello: SupervisorHello): void {
    if (this.ready) {
      this.abandon(SUPERVISOR_CLOSE.protocolError, { kind: "protocol_error", message: "the supervisor said hello twice" });
      return;
    }
    if (this.instance !== undefined && this.instance !== hello.instance) {
      this.abandon(1000, {
        kind: "restarted",
        message: `supervisor ${hello.instance} answered where ${this.instance} ran`,
      });
      return;
    }
    this.instance = hello.instance;
    this.hello = hello;
    this.ready = true;
    this.delay = this.reconnect.initial;
    const believedLive = this.live;
    this.live = hello.state === "running" ? hello.runId : undefined;
    this.options.listener.onConnected(hello);
    if (this.live !== undefined) this.onStarted(this.live);
    if (believedLive !== undefined && believedLive !== this.live) {
      // Ended while disconnected: the supervisor answers its ending.
      this.send({ type: "stop", runId: believedLive, graceMs: STOP_QUERY_GRACE_MS });
    }
    for (const pending of this.pendingRuns.values()) {
      if (pending.run.runId !== this.live) this.send(this.runMessage(pending.run));
    }
    for (const stop of this.pendingStops.splice(0)) {
      this.send({ type: "stop", runId: stop.runId, graceMs: stop.graceMs });
      stop.resolve();
    }
    this.settleConnect(undefined, hello);
  }

  private onStarted(runId: string): void {
    this.live = runId;
    if (this.lastStarted !== runId) {
      this.lastStarted = runId;
      this.options.listener.onStarted(runId);
    }
    this.takeRun(runId)?.resolve();
  }

  private onEnded(ending: SupervisorRunEnding): void {
    if (this.live === ending.runId) this.live = undefined;
    this.takeRun(ending.runId)?.resolve();
    if (this.lastEnded !== ending.runId) {
      this.lastEnded = ending.runId;
      this.options.listener.onExited(ending);
    }
  }

  private onFailed(runId: string, reason: string): void {
    if (this.live === runId) this.live = undefined;
    this.takeRun(runId)?.reject(new SupervisorRunFailed(runId, reason));
    if (this.lastEnded !== runId) {
      this.lastEnded = runId;
      this.options.listener.onFailed(runId, reason);
    }
  }

  private onRefused(runId: string, code: "run_active" | "no_run"): void {
    if (code === "run_active") {
      this.takeRun(runId)?.reject(
        new AppRunRefused("run_active", `another run is live in this container (refused ${runId})`),
      );
    }
    this.options.listener.onRefused(runId, code);
  }

  private onFrame(bytes: Buffer): void {
    if (!this.ready) {
      this.abandon(SUPERVISOR_CLOSE.protocolError, { kind: "protocol_error", message: "output arrived before hello" });
      return;
    }
    let frame;
    try {
      frame = decodeOutputFrame(bytes);
    } catch (error) {
      this.abandon(SUPERVISOR_CLOSE.protocolError, {
        kind: "protocol_error",
        message: `the supervisor sent a malformed frame: ${(error as Error).message}`,
      });
      return;
    }
    if (frame.seq <= this.seq) return;
    if (frame.seq > this.seq + 1) this.options.listener.onGap(this.seq + 1, frame.seq);
    this.seq = frame.seq;
    this.options.listener.onOutput(frame.payload, frame.stream, frame.seq);
  }

  private takeRun(runId: string): PendingRun | undefined {
    const pending = this.pendingRuns.get(runId);
    this.pendingRuns.delete(runId);
    return pending;
  }

  private send(message: RunnerMessage, socket = this.socket): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    // A message lost to a dropping connection is re-sent by the next hello's
    // reconciliation; the drop itself arrives as `close`.
    socket.send(encodeRunnerMessage(message));
  }

  /** Closes the socket ourselves and terminates. */
  private abandon(code: number, termination: SupervisorTermination): void {
    const socket = this.socket;
    this.socket = undefined;
    this.ready = false;
    socket?.close(code, termination.message.slice(0, 120));
    this.terminate(termination);
  }

  private terminate(termination: SupervisorTermination): void {
    this.termination = termination;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.rejectPending(new SupervisorTerminated(termination));
    this.options.listener.onTerminated(termination);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRuns.values()) pending.reject(error);
    this.pendingRuns.clear();
    for (const stop of this.pendingStops.splice(0)) stop.reject(error);
    this.settleConnect(error);
  }

  private settleConnect(error: Error | undefined, hello?: SupervisorHello): void {
    for (const waiter of this.connectWaiters.splice(0)) {
      if (error) waiter.reject(error);
      else if (hello) waiter.resolve(hello);
    }
  }
}
