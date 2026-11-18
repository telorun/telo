import { Duplex } from "node:stream";

import { TUNNEL_BINARY_MESSAGE_MAX_BYTES } from "@telorun/share-tunnel";
import type { WebSocket } from "ws";

import { ByteRate } from "./byte-rate.js";

/**
 * The tunnel's HTTP/2 byte stream over the WebSocket's binary messages, each
 * direction held to the tunnel's byte rate. Received bytes pause the WebSocket
 * while the reader is behind or the inbound rate is owed; a write completes once
 * its bytes are sent and the outbound rate is paid, so HTTP/2 writes nothing
 * more meanwhile and its flow control holds every body back.
 */
export class TunnelDuplex extends Duplex {
  private readonly inbound: ByteRate;
  private readonly outbound: ByteRate;
  private readerBehind = false;
  private owedUntil: NodeJS.Timeout | undefined;

  constructor(
    private readonly ws: WebSocket,
    bytesPerSecond: number,
  ) {
    super({ readableHighWaterMark: TUNNEL_BINARY_MESSAGE_MAX_BYTES });
    this.inbound = new ByteRate(bytesPerSecond);
    this.outbound = new ByteRate(bytesPerSecond);
  }

  /** One binary message received from the client. */
  receive(data: Buffer): void {
    if (this.destroyed || this.readableEnded) return;
    const wait = this.inbound.take(data.length);
    if (!this.push(data)) this.readerBehind = true;
    if (wait > 0) {
      if (this.owedUntil !== undefined) clearTimeout(this.owedUntil);
      this.owedUntil = setTimeout(() => {
        this.owedUntil = undefined;
        this.updateFlow();
      }, wait);
    }
    this.updateFlow();
  }

  /** Whether the WebSocket is paused for the reader or the inbound rate. */
  get holding(): boolean {
    return this.readerBehind || this.owedUntil !== undefined;
  }

  /** The WebSocket ended: no more bytes will arrive. */
  receiveEnd(): void {
    if (!this.destroyed && !this.readableEnded) this.push(null);
  }

  override _read(): void {
    this.readerBehind = false;
    this.updateFlow();
  }

  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.sendAll(chunk, callback);
  }

  override _writev(
    chunks: Array<{ chunk: Buffer; encoding: BufferEncoding }>,
    callback: (error?: Error | null) => void,
  ): void {
    this.sendAll(Buffer.concat(chunks.map((entry) => entry.chunk)), callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    callback();
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    if (this.owedUntil !== undefined) clearTimeout(this.owedUntil);
    this.owedUntil = undefined;
    callback(error);
  }

  private updateFlow(): void {
    if (this.destroyed) return;
    const hold = this.holding;
    if (hold && !this.ws.isPaused) this.ws.pause();
    else if (!hold && this.ws.isPaused) this.ws.resume();
  }

  private sendAll(bytes: Buffer, callback: (error?: Error | null) => void): void {
    const wait = this.outbound.take(bytes.length);
    let pending = 1;
    let failed = false;
    const done = (error?: Error | null) => {
      if (failed) return;
      if (error) {
        failed = true;
        callback(error);
        return;
      }
      if (--pending === 0) callback();
    };
    if (wait > 0) {
      pending++;
      setTimeout(() => done(), wait);
    }
    // ws fails a send once the socket is closing; HTTP/2's last bytes then go nowhere.
    if (this.ws.readyState !== this.ws.OPEN) {
      done(new Error("the tunnel is closed"));
      return;
    }
    for (let at = 0; at < bytes.length; at += TUNNEL_BINARY_MESSAGE_MAX_BYTES) {
      pending++;
      this.ws.send(bytes.subarray(at, at + TUNNEL_BINARY_MESSAGE_MAX_BYTES), { binary: true }, done);
    }
    done();
  }
}
