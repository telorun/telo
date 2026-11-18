import { Duplex } from "node:stream";

import type { WebSocket } from "ws";

import { TUNNEL_BINARY_MESSAGE_MAX_BYTES } from "./tunnel-protocol.js";

/**
 * The tunnel's HTTP/2 byte stream over a WebSocket's binary messages. Message
 * boundaries mean nothing: writes are sent as binary messages of at most the
 * protocol's binary limit, and received binary messages are handed to
 * `receive` in order. Reading pauses the WebSocket while the consumer is behind.
 */
export class WebSocketDuplex extends Duplex {
  constructor(private readonly ws: WebSocket) {
    super({ readableHighWaterMark: TUNNEL_BINARY_MESSAGE_MAX_BYTES });
  }

  /** One binary message received from the peer. */
  receive(data: Buffer): void {
    // Once the HTTP/2 connection is gone nothing reads its bytes.
    if (this.destroyed || this.readableEnded) return;
    if (!this.push(data)) this.ws.pause();
  }

  /** The WebSocket ended: no more bytes will arrive. */
  receiveEnd(): void {
    this.push(null);
  }

  override _read(): void {
    if (this.ws.isPaused) this.ws.resume();
  }

  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.sendAll([chunk], callback);
  }

  override _writev(
    chunks: Array<{ chunk: Buffer; encoding: BufferEncoding }>,
    callback: (error?: Error | null) => void,
  ): void {
    this.sendAll(
      chunks.map((entry) => entry.chunk),
      callback,
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    callback();
  }

  private sendAll(chunks: Buffer[], callback: (error?: Error | null) => void): void {
    const messages = pack(chunks);
    let pending = messages.length;
    let failed = false;
    if (pending === 0) {
      callback();
      return;
    }
    for (const message of messages) {
      this.ws.send(message, { binary: true }, (error) => {
        if (failed) return;
        if (error) {
          failed = true;
          callback(error);
          return;
        }
        if (--pending === 0) callback();
      });
    }
  }
}

/** The chunks as messages of at most the binary limit, small ones coalesced. */
function pack(chunks: Buffer[]): Buffer[] {
  const whole = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
  const messages: Buffer[] = [];
  for (let at = 0; at < whole.length; at += TUNNEL_BINARY_MESSAGE_MAX_BYTES) {
    messages.push(whole.subarray(at, at + TUNNEL_BINARY_MESSAGE_MAX_BYTES));
  }
  return messages;
}
