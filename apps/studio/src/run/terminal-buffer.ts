import type { RunIo, RunIoConnection } from "./types";

/** Cap on retained transcript bytes. Past this the oldest chunks are evicted
 *  (a one-time truncation notice is shown on replay). Generous vs. typical run
 *  output; multiplied across the per-app history cap it bounds memory. */
const DEFAULT_TRANSCRIPT_CAP_BYTES = 2 * 1024 * 1024;
const TRUNCATION_NOTICE = new TextEncoder().encode(
  "\r\n\x1b[2m[earlier output truncated]\x1b[0m\r\n",
);

type TerminalListener = (bytes: Uint8Array) => void;

/** Owns the single `RunIo.open()` call for one run and records its byte
 *  transcript. A terminal view `attach()`es to replay the transcript into a
 *  fresh xterm and then stream live bytes — re-attaching is always safe,
 *  unlike `RunIo.open()` which is single-shot. This both keeps a run's output
 *  re-viewable across remounts / history selection and removes the double-open
 *  crash, since the buffer (not the view) is the sole `open()` caller. */
export class TerminalBuffer {
  private readonly connection: RunIoConnection;
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;
  private truncated = false;
  private closed = false;
  private listener: TerminalListener | null = null;

  constructor(io: RunIo, private readonly capBytes = DEFAULT_TRANSCRIPT_CAP_BYTES) {
    this.connection = io.open({
      onData: (bytes) => this.record(bytes),
      onClose: () => {
        this.closed = true;
      },
    });
  }

  private record(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.chunks.push(bytes);
    this.bytes += bytes.byteLength;
    while (this.bytes > this.capBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.bytes -= dropped.byteLength;
      this.truncated = true;
    }
    this.listener?.(bytes);
  }

  /** Replays the recorded transcript immediately, then forwards live bytes to
   *  `onData`. Returns a detach fn; detaching does NOT tear down the transport
   *  (the transcript stays for the next attach). */
  attach(onData: TerminalListener): () => void {
    this.listener = onData;
    if (this.truncated) onData(TRUNCATION_NOTICE);
    for (const chunk of this.chunks) onData(chunk);
    return () => {
      if (this.listener === onData) this.listener = null;
    };
  }

  send(bytes: Uint8Array): void {
    if (this.closed) return;
    this.connection.send(bytes);
  }

  resize(cols: number, rows: number): void {
    if (this.closed) return;
    this.connection.resize(cols, rows);
  }

  /** Tears down the underlying transport. Called when the run is evicted from
   *  history or the provider unmounts — never on a terminal view detach. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.connection.close();
    } catch {
      /* already closed */
    }
  }
}
