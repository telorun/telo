import type { RunIo, RunIoConnection, RunIoHandlers } from "../../types";

const STORAGE_PREFIX = "telo-editor:io-last-seq:";
const RESIZE_DEBOUNCE_MS = 50;
const MAX_BACKOFF_MS = 10_000;
const SEQ_PREFIX_BYTES = 4;
// Application-level close codes the runner emits — we do not auto-reconnect
// on these, since they describe terminal conditions on the server side.
const TERMINAL_CLOSE_CODES = new Set<number>([1000, 1001, 1005, 4403, 4404, 4410]);

interface IoClientDeps {
  url: string;
  sessionId: string;
}

interface ServerControlFrame {
  type?: string;
  seq?: number;
  reason?: string;
}

/**
 * Builds a `RunIo` capability that resolves a fresh WebSocket on each
 * `open()` call. Reconnects transparently on transient close codes, replays
 * from `lastSeq` persisted in `sessionStorage`, and surfaces a `gap`
 * diagnostic on the byte stream when the runner reports buffer eviction.
 */
export function makeHttpRunnerIo(deps: IoClientDeps): RunIo {
  const storageKey = `${STORAGE_PREFIX}${deps.sessionId}`;
  let opened = false;

  return {
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
      // The server prefixes every binary frame with the authoritative seq.
      // We persist the largest one we've consumed so a reconnect (or a
      // fresh tab via sessionStorage) tells the server where to resume,
      // and so duplicate frames during replay/queue-drain are skipped.
      let lastSeq = readPersistedSeq(storageKey);

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

      const connect = (): void => {
        if (closed) return;

        const url = new URL(deps.url);
        if (lastSeq > 0) {
          url.searchParams.set("lastSeq", String(lastSeq));
        }

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
              handlers.onData(new TextEncoder().encode(note));
            }
            return;
          }

          // Binary frame — `[seq:4 BE][payload:N]`. The seq prefix is the
          // server's authoritative chunk id; we use it for dedup on
          // reconnect/replay, NOT a client-side counter (counting frames
          // would silently drift if any frame were lost or duplicated).
          if (!(event.data instanceof ArrayBuffer)) return;
          if (event.data.byteLength < SEQ_PREFIX_BYTES) return;
          const view = new DataView(event.data);
          const seq = view.getUint32(0, false);
          if (seq <= lastSeq) return;
          lastSeq = seq;
          persistSeq(storageKey, lastSeq);
          handlers.onData(new Uint8Array(event.data, SEQ_PREFIX_BYTES));
        });

        ws.addEventListener("close", (event: CloseEvent) => {
          socket = null;
          if (closed) return;
          if (TERMINAL_CLOSE_CODES.has(event.code)) {
            closed = true;
            handlers.onClose({ code: event.code, clean: event.wasClean });
            return;
          }
          // Transient close — schedule a reconnect with exponential backoff.
          const delay = backoffMs;
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
          setTimeout(connect, delay);
        });

        ws.addEventListener("error", () => {
          // ws fires `error` followed by `close` on most failures; the close
          // handler decides whether to retry. Swallow here.
        });
      };

      connect();

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

function readPersistedSeq(key: string): number {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function persistSeq(key: string, seq: number): void {
  try {
    window.sessionStorage.setItem(key, String(seq));
  } catch {
    // sessionStorage can be disabled/full — replay degrades to "from zero".
  }
}
