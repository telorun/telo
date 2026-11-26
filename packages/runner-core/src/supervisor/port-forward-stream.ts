import { Duplex } from "node:stream";

import WebSocket from "ws";

import { SUPERVISOR_CLOSE, portForwardTarget } from "./supervisor-protocol.js";

/** A port forward the supervisor closed with anything but `1000`: `4502` when
 *  nothing accepts a connection on the port, `4401` / `4403` for the token,
 *  `4400` for a request it refused. */
export class PortForwardClosed extends Error {
  constructor(
    public readonly port: number,
    public readonly code: number,
    public readonly reason: string,
  ) {
    super(`the port forward to 127.0.0.1:${port} closed ${code}: ${reason}`);
    this.name = "PortForwardClosed";
  }
}

export interface PortForwardOptions {
  /** The supervisor's address as the runner reaches it. */
  host: string;
  port: number;
  token: string;
  /** The port inside the workload, dialled by the supervisor at `127.0.0.1`. */
  target: number;
  signal?: AbortSignal;
}

/**
 * Opens a port forward through a session supervisor (spec § 8): a byte stream
 * to `127.0.0.1:<target>` inside the workload. Resolves once the upgrade
 * completed, which is when the supervisor dials the port, so a port nothing
 * listens on ends the stream with `PortForwardClosed` (`4502`) rather than
 * rejecting here. The port closing its connection ends the stream; ending or
 * destroying the stream closes the forward, since a WebSocket has no half-close.
 */
export function openPortForward(options: PortForwardOptions): Promise<Duplex> {
  const { host, port, token, target, signal } = options;
  const path = portForwardTarget(target);
  if (signal?.aborted) return Promise.reject(signal.reason);
  const authority = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
  const socket = new WebSocket(`ws://${authority}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    perMessageDeflate: false,
    handshakeTimeout: 10_000,
  });
  return new Promise<Duplex>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = (): void => {
      fail(signal!.reason as Error);
      socket.terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("error", fail);
    socket.once("close", (code, reason) => fail(new PortForwardClosed(target, code, reason.toString("utf8"))));
    socket.once("open", () => {
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      resolve(new PortForwardStream(socket, target, signal));
    });
  });
}

class PortForwardStream extends Duplex {
  private failure: string | undefined;
  private readonly onAbort = (): void => {
    this.destroy(this.signal!.reason as Error);
  };

  constructor(
    private readonly socket: WebSocket,
    private readonly target: number,
    private readonly signal: AbortSignal | undefined,
  ) {
    super({ allowHalfOpen: false });
    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        const error = new PortForwardClosed(target, SUPERVISOR_CLOSE.protocolError, "the supervisor sent a text frame");
        socket.close(SUPERVISOR_CLOSE.protocolError, "a port forward carries binary frames only");
        this.destroy(error);
        return;
      }
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (!this.push(bytes)) socket.pause();
    });
    socket.on("error", (error) => {
      this.failure = error.message;
    });
    socket.on("close", (code, reason) => {
      signal?.removeEventListener("abort", this.onAbort);
      if (code === 1000) this.push(null);
      else this.destroy(new PortForwardClosed(target, code, reason.toString("utf8") || this.failure || "connection lost"));
    });
    signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  override _read(): void {
    if (this.socket.isPaused) this.socket.resume();
  }

  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.socket.send(chunk, { binary: true }, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.socket.close(1000, "the runner ended the forward");
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.signal?.removeEventListener("abort", this.onAbort);
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, "the runner ended the forward");
    else if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate();
    callback(error);
  }
}
