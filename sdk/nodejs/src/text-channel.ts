import type { Stream } from "./stream.js";

/**
 * A duplex, line-oriented text channel with something running on the other end:
 * a child application, a shell session, an SSH host, a serial port, a text
 * WebSocket.
 *
 * The contract exists at this level because "hold a conversation with a running
 * program" is the same problem for all of them. A vocabulary owned by whichever
 * module needed it first would force the second one either to import that module
 * — a shell session is not an application — or to re-invent reading and writing
 * with its own timeout rule, its own match rule and its own error codes, leaving
 * a manifest unable to reuse a single step across the two.
 */
export interface TextChannel {
  /**
   * Begin reading what the program writes, and return the stream of it.
   *
   * Called ONCE, by whoever is going to read, and called before the program
   * starts producing — which is why it is a call and not a property. A channel
   * nobody reads retains nothing, so supervising a long-running program costs no
   * memory; and a property that quietly began retaining on first access would
   * make that difference invisible at the call site.
   *
   * A second call is an error: two readers of one channel would take each
   * other's bytes, and which one got a given line would depend on scheduling.
   */
  openOutput(): Stream<string>;
  /** The write end. A program nobody writes to reads nothing rather than the
   *  host's own input. */
  readonly input: TextChannelInput;
}

/**
 * The write end of a text channel.
 *
 * Text is written verbatim — a program reading LINES needs the newline that ends
 * one, and appending it here would make "send half a line" unexpressible.
 */
export interface TextChannelInput {
  /** Resolves once the program has taken the text. Writing after {@link end}, or
   *  to a program that has exited, is an error rather than a silent no-op: the
   *  caller believed someone was listening. */
  write(text: string): Promise<void>;
  /** No more input is coming. A program waiting for a line stops waiting and
   *  reads end-of-input. Idempotent. */
  end(): Promise<void>;
}
