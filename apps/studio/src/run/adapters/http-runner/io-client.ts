import { SessionGoneError, type RunIoConnection, type RunIoHandlers, type SequencedRunIo } from "../../types";

const RESIZE_DEBOUNCE_MS = 50;
const MAX_BACKOFF_MS = 10_000;
const SEQ_PREFIX_BYTES = 4;
const STREAM_TAG_BYTES = 1;
/** Wire codes for the per-frame stream tag: `tty` under a terminal attach,
 *  `stdout`/`stderr` only where the transport genuinely separated them. */
const STREAM_TAGS = ["tty", "stdout", "stderr"] as const;
// Application-level close codes the runner emits — we do not auto-reconnect
// on these, since they describe terminal conditions on the server side.
const TERMINAL_CLOSE_CODES = new Set<number>([1000, 1001, 1005, 4401, 4403, 4404, 4410]);
/** The close reported when the session is gone before a ticket could be minted —
 *  the code the runner itself closes a gone session's channel with. */
const SESSION_GONE_CLOSE = 4404;

interface IoClientDeps {
  /** `ws(s)://…/v1/sessions/:id/io`. */
  url: string;
  /** Deliver the output after this sequence: the previous run's last, so a
   *  run's terminal shows that run alone, or 0 for everything buffered. */
  fromSeq: number;
  /** A single-use ticket for this app's channel, minted for each connection —
   *  a browser cannot set a header on an upgrade, and a credential must never
   *  appear in a URL. */
  ticket(): Promise<string>;
}

interface ServerControlFrame {
  type?: string;
  seq?: number;
  reason?: string;
}

/**
 * Builds a `RunIo` capability over one app's byte channel. Each connection
 * takes a fresh ticket; it reconnects transparently on transient close codes,
 * resumes from the last sequence it delivered, and surfaces a `gap` diagnostic
 * on the byte stream when the runner reports buffer eviction.
 */
export function makeHttpRunnerIo(deps: IoClientDeps): SequencedRunIo {
  let opened = false;
  // The server prefixes every binary frame with the authoritative seq. The
  // largest one consumed tells a reconnect where to resume, and skips
  // duplicates during replay.
  let lastSeq = deps.fromSeq;

  return {
    lastSeq: () => lastSeq,
    open(handlers: RunIoHandlers): RunIoConnection {
      if (opened) {
        throw new Error("RunIo.open() may be called only once per session");
      }
      opened = true;
      let socket: WebSocket | null = null;
      let closed = false;
      let backoffMs = 250;
      let pendingResize: { cols: number; rows: number } | null = null;
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const sendQueue: Uint8Array[] = [];
      const controlQueue: string[] = [];

      const flushQueues = (): void => {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        while (sendQueue.length > 0) {
          const buf = sendQueue.shift()!;
          socket.send(buf);
        }
        while (controlQueue.length > 0) {
          const msg = controlQueue.shift()!;
          socket.send(msg);
        }
      };

      const retry = (): void => {
        const delay = backoffMs;
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        setTimeout(() => void connect(), delay);
      };

      const connect = async (): Promise<void> => {
        if (closed) return;

        let ticket: string;
        try {
          ticket = await deps.ticket();
        } catch (err) {
          if (closed) return;
          if (err instanceof SessionGoneError) {
            closed = true;
            handlers.onClose({ code: SESSION_GONE_CLOSE, clean: true });
            return;
          }
          retry();
          return;
        }
        if (closed) return;

        const url = new URL(deps.url);
        url.searchParams.set("ticket", ticket);
        // Explicit, from zero too: never rely on the server's absent-param default.
        url.searchParams.set("lastSeq", String(lastSeq));

        const ws = new WebSocket(url.toString());
        ws.binaryType = "arraybuffer";
        socket = ws;

        ws.addEventListener("open", () => {
          backoffMs = 250;
          flushQueues();
        });

        ws.addEventListener("message", (event: MessageEvent) => {
          if (typeof event.data === "string") {
            // Control frame.
            let parsed: ServerControlFrame;
            try {
              parsed = JSON.parse(event.data) as ServerControlFrame;
            } catch {
              return;
            }
            if (parsed.type === "gap") {
              // Surface a one-line diagnostic on the byte stream so xterm
              // renders it inline. Dim style emitted as an ANSI escape; the
              // terminal handles rendering.
              const note = "\r\n\x1b[2m[stream reconnected — earlier output truncated]\x1b[0m\r\n";
              handlers.onData(new TextEncoder().encode(note), "tty");
            }
            return;
          }

          // Binary frame — `[seq:4 BE][stream:1][payload:N]`. The seq prefix is
          // the server's authoritative chunk id; we use it for dedup on
          // reconnect/replay, NOT a client-side counter (counting frames
          // would silently drift if any frame were lost or duplicated).
          if (!(event.data instanceof ArrayBuffer)) return;
          if (event.data.byteLength < SEQ_PREFIX_BYTES + STREAM_TAG_BYTES) return;
          const view = new DataView(event.data);
          const seq = view.getUint32(0, false);
          if (seq <= lastSeq) return;
          lastSeq = seq;
          const stream = STREAM_TAGS[view.getUint8(SEQ_PREFIX_BYTES)] ?? "tty";
          handlers.onData(
            new Uint8Array(event.data, SEQ_PREFIX_BYTES + STREAM_TAG_BYTES),
            stream,
          );
        });

        ws.addEventListener("close", (event: CloseEvent) => {
          socket = null;
          if (closed) return;
          if (TERMINAL_CLOSE_CODES.has(event.code)) {
            closed = true;
            handlers.onClose({ code: event.code, clean: event.wasClean });
            return;
          }
          // Transient close — reconnect with a fresh ticket, backing off.
          retry();
        });

        ws.addEventListener("error", () => {
          // ws fires `error` followed by `close` on most failures; the close
          // handler decides whether to retry. Swallow here.
        });
      };

      void connect();

      return {
        send(bytes: Uint8Array): void {
          if (closed) return;
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(bytes);
          } else {
            sendQueue.push(bytes);
          }
        },
        resize(cols: number, rows: number): void {
          if (closed) return;
          pendingResize = { cols, rows };
          if (resizeTimer !== null) return;
          resizeTimer = setTimeout(() => {
            resizeTimer = null;
            const next = pendingResize;
            pendingResize = null;
            if (!next) return;
            const frame = JSON.stringify({ type: "resize", cols: next.cols, rows: next.rows });
            if (socket && socket.readyState === WebSocket.OPEN) {
              socket.send(frame);
            } else {
              controlQueue.push(frame);
            }
          }, RESIZE_DEBOUNCE_MS);
        },
        close(): void {
          if (closed) return;
          closed = true;
          if (resizeTimer !== null) clearTimeout(resizeTimer);
          if (socket) {
            try {
              socket.close(1000, "client closed");
            } catch {
              /* ignore */
            }
            socket = null;
          }
        },
      };
    },
  };
}
