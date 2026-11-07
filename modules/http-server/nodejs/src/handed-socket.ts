import type { HandedConnection } from "@telorun/sdk";
import { Duplex } from "node:stream";

/**
 * A connection the host handed over, as the socket Node's HTTP layer serves:
 * reads pull its inbound channel — the host's replayed bytes first — and writes
 * go out through its outbound one. Carries the members of `net.Socket` the HTTP
 * layer and an upgrade handler call.
 */
export class HandedSocket extends Duplex {
  readonly remoteAddress: string | undefined;
  readonly remotePort: number | undefined;
  readonly remoteFamily: string | undefined;
  readonly #connection: HandedConnection;
  readonly #reader: AsyncIterator<Uint8Array>;
  #pulling = false;
  #timeout = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(connection: HandedConnection) {
    super({ allowHalfOpen: false });
    this.#connection = connection;
    this.#reader = connection.inbound[Symbol.asyncIterator]();
    const peer = peerOf(connection.peer);
    this.remoteAddress = peer.address;
    this.remotePort = peer.port;
    this.remoteFamily = peer.address === undefined ? undefined : peer.address.includes(":") ? "IPv6" : "IPv4";
  }

  override _read(): void {
    if (this.#pulling) return;
    this.#pulling = true;
    void this.#pull();
  }

  async #pull(): Promise<void> {
    try {
      for (;;) {
        const next = await this.#reader.next();
        if (next.done) {
          this.push(null);
          return;
        }
        this.#touch();
        const chunk = next.value;
        if (!this.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))) return;
      }
    } catch (error) {
      this.destroy(error as Error);
    } finally {
      this.#pulling = false;
    }
  }

  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.#touch();
    this.#connection.write(chunk).then(() => callback(), callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#closed = true;
    this.#connection.close().then(() => callback(), callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    clearTimeout(this.#timer);
    const closing = this.#closed
      ? Promise.resolve()
      : this.#connection.close({ code: "ECONNRESET", message: error?.message ?? "the server destroyed the connection" });
    this.#closed = true;
    // Closing the connection is what ends its inbound channel.
    closing.then(
      () => callback(error),
      (closeError: unknown) => callback(error ?? (closeError as Error)),
    );
  }

  /** As `net.Socket.setTimeout`: `timeout` is emitted after `ms` without traffic. */
  setTimeout(ms: number, callback?: () => void): this {
    if (callback) {
      if (ms === 0) this.off("timeout", callback);
      else this.once("timeout", callback);
    }
    this.#timeout = ms;
    this.#arm();
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  /** As `net.Socket.destroySoon`: destroyed once what was written is flushed. */
  destroySoon(): void {
    if (this.writable) this.end();
    if (this.writableFinished) this.destroy();
    else this.once("finish", () => this.destroy());
  }

  #touch(): void {
    if (this.#timeout > 0) this.#arm();
  }

  #arm(): void {
    clearTimeout(this.#timer);
    this.#timer = this.#timeout > 0 ? setTimeout(() => this.emit("timeout"), this.#timeout).unref() : undefined;
  }
}

function peerOf(peer: string): { address?: string; port?: number } {
  const at = peer.lastIndexOf(":");
  if (at === -1) return { address: peer };
  const port = Number(peer.slice(at + 1));
  const address = peer.slice(0, at).replace(/^\[(.*)\]$/, "$1");
  return Number.isInteger(port) ? { address, port } : { address: peer };
}
