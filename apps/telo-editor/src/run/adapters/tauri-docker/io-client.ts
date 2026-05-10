import { Channel, invoke } from "@tauri-apps/api/core";

import type { RunIo, RunIoConnection, RunIoHandlers } from "../../types";

const RESIZE_DEBOUNCE_MS = 50;

export interface TauriIoBootstrap {
  io: RunIo;
  /** The Tauri Channel constructed before `run_start` is invoked — pass this
   *  as one of the `run_start` parameters. The bootstrap installs its
   *  `onmessage` handler at construction so no bytes are lost between Rust
   *  spawning the docker process and the consumer (TerminalView) calling
   *  `io.open()`. */
  channel: Channel<ArrayBuffer | Uint8Array | number[]>;
}

/** Cap on bytes the pre-mount buffer can hold. Without this cap, a long
 *  startup output combined with a delayed (or skipped) `open()` would grow
 *  unbounded — a real memory leak. The cap is generous compared to typical
 *  startup output (~1 MB), so most users never see truncation. */
const PREOPEN_BUFFER_BYTES = 1 * 1024 * 1024;
const TRUNCATION_NOTICE = new TextEncoder().encode(
  "\r\n\x1b[2m[pre-open buffer truncated — earlier output dropped]\x1b[0m\r\n",
);

/** Constructs a Tauri Channel + RunIo capability pair for a session. The
 *  caller hands the returned `channel` to `invoke("run_start", { ..., ioChannel })`
 *  and exposes the returned `io` on the RunSession. */
export function makeTauriDockerIo(sessionId: string): TauriIoBootstrap {
  const channel = new Channel<ArrayBuffer | Uint8Array | number[]>();
  // Bytes that arrived before the consumer attached. Drained on first `open`.
  const buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let bufferTruncated = false;
  let liveHandlers: RunIoHandlers | null = null;
  let connectionClosed = false;

  const evictUntilFits = (): void => {
    while (bufferedBytes > PREOPEN_BUFFER_BYTES && buffered.length > 1) {
      const dropped = buffered.shift()!;
      bufferedBytes -= dropped.byteLength;
      bufferTruncated = true;
    }
  };

  channel.onmessage = (payload) => {
    if (connectionClosed) return;
    const bytes = toUint8Array(payload);
    if (bytes.byteLength === 0) return;
    if (liveHandlers) {
      liveHandlers.onData(bytes);
    } else {
      buffered.push(bytes);
      bufferedBytes += bytes.byteLength;
      if (bufferedBytes > PREOPEN_BUFFER_BYTES) evictUntilFits();
    }
  };

  let opened = false;
  return {
    channel,
    io: {
      open(handlers: RunIoHandlers): RunIoConnection {
        if (opened) {
          throw new Error("RunIo.open() may be called only once per session");
        }
        opened = true;
        liveHandlers = handlers;
        // Surface a one-time truncation notice if the pre-open buffer
        // overflowed; it's emitted before the kept tail so the user reads
        // the marker first, then the actually-retained startup output.
        if (bufferTruncated) {
          handlers.onData(TRUNCATION_NOTICE);
          bufferTruncated = false;
        }
        // Replay anything that arrived before mount.
        while (buffered.length > 0) {
          handlers.onData(buffered.shift()!);
        }
        bufferedBytes = 0;

        let pendingResize: { cols: number; rows: number } | null = null;
        let resizeTimer: ReturnType<typeof setTimeout> | null = null;

        return {
          send(bytes: Uint8Array): void {
            if (connectionClosed) return;
            // Tauri 2 invoke serializes parameters as JSON, so a Uint8Array
            // becomes a number array on the wire (Vec<u8> on the Rust side
            // deserializes the array). This inflates each byte ~4x. For
            // keystrokes the absolute volume is tiny; for very large pastes
            // (multi-MB) consider migrating this to a tauri::ipc::Request
            // body. Deliberate trade-off, not a regression workaround.
            void invoke("run_send_input", {
              sessionId,
              bytes: Array.from(bytes),
            }).catch(() => {
              // Pipe gone — exit task will surface terminal status separately.
            });
          },
          resize(cols: number, rows: number): void {
            if (connectionClosed) return;
            pendingResize = { cols, rows };
            if (resizeTimer !== null) return;
            resizeTimer = setTimeout(() => {
              resizeTimer = null;
              const next = pendingResize;
              pendingResize = null;
              if (!next) return;
              void invoke("run_resize", {
                sessionId,
                cols: next.cols,
                rows: next.rows,
              }).catch(() => {
                // 404 from `docker resize` after exit is expected; ignore.
              });
            }, RESIZE_DEBOUNCE_MS);
          },
          close(): void {
            if (connectionClosed) return;
            connectionClosed = true;
            liveHandlers = null;
            if (resizeTimer !== null) clearTimeout(resizeTimer);
            void invoke("run_close_input", { sessionId }).catch(() => {
              // Session already gone — nothing to close.
            });
            handlers.onClose({ code: 1000, clean: true });
          },
        };
      },
    },
  };
}

/** The Rust side sends `Vec<u8>` over a Tauri Channel, which serializes
 *  as a JSON number array — what reaches `onmessage` here is a `number[]`.
 *  We accept ArrayBuffer / Uint8Array as well so a future migration to a
 *  binary-channel transport (less wire overhead) doesn't have to update
 *  every call site. Normalize to Uint8Array. */
function toUint8Array(payload: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (Array.isArray(payload)) return new Uint8Array(payload);
  return new Uint8Array(0);
}
