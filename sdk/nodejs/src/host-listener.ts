/**
 * A connection the host admitted and handed over (`Listener.Accept`,
 * `kernel/specs/controller-protocol.md` §9.4): two one-way byte channels, never
 * an OS handle.
 */
export interface HandedConnection {
  /** The connection's remote end, `<address>:<port>`. */
  readonly peer: string;
  /** What the peer sends, beginning with the bytes the host already read while
   *  admitting the connection. Its end is the peer's end of the connection. */
  readonly inbound: AsyncIterable<Uint8Array>;
  /** Sends bytes to the peer; resolves once they are taken. */
  write(chunk: Uint8Array): Promise<void>;
  /** Ends the connection once what was written is delivered — or, with an
   *  `error`, resets it at once. */
  close(error?: { code: string; message: string }): Promise<void>;
}

/** A host socket a server claimed (`Listener.Claim`). */
export interface ClaimedListener {
  /** The address the host's socket is bound to. */
  readonly address: string;
  /** The claim's inverse (`Listener.Release`): no connection is handed over
   *  after it resolves, and connections already handed over are untouched.
   *  Idempotent. */
  release(): Promise<void>;
}
