import type { LogRecord } from "@telorun/sdk";
import { toJsonProfile, type BytesEncoder } from "./encode-json.js";
import type { LogSinkInstance } from "./log-sink.js";

/**
 * The `debug-wire` sink — `kernel/specs/logging.md` §10.2 and §11.4.
 *
 * **Not declarable.** It is host-attached when a debug consumer connects
 * (`--debug` / `--inspect`) and detached on disconnect, which makes it tooling
 * attachment rather than application configuration — the same category as TTY
 * detection, not a violation of D6.
 *
 * Not sync-flushable: delivery crosses an SSE/stream boundary owned by the host,
 * so a `fatal` record's flush here is initiated but never awaited (§10.5).
 */

export const DEBUG_WIRE_SINK_ID = "<debug-wire>";

export class DebugWireSink implements LogSinkInstance {
  readonly sinkId = DEBUG_WIRE_SINK_ID;
  readonly level: number;
  readonly syncFlushable = false;

  readonly #emit: (frame: { kind: "record"; timestamp: string; record: Record<string, unknown> }) => void;
  readonly #encodeBytes: BytesEncoder | undefined;

  constructor(options: {
    level: number;
    /** Hands a §11.4 `record` frame to the host's wire writer. */
    emit: (frame: { kind: "record"; timestamp: string; record: Record<string, unknown> }) => void;
    /** Offloads `bytes` attributes to the host's blob store when it has one —
     *  the debug wire does. Raw bytes are never inlined (§6.1). */
    encodeBytes?: BytesEncoder;
  }) {
    this.level = options.level;
    this.#emit = options.emit;
    this.#encodeBytes = options.encodeBytes;
  }

  write(record: LogRecord): void {
    const profile = toJsonProfile(record);
    if (this.#encodeBytes) offloadBytes(profile, this.#encodeBytes);
    this.#emit({
      kind: "record",
      timestamp: new Date(Number(record.timestamp / 1_000_000n)).toISOString(),
      record: profile,
    });
  }

  async flush(): Promise<void> {
    // Frames are handed to the host synchronously; the host owns delivery.
  }

  flushSync(): void {
    // Never synchronously drainable — see the class doc.
  }

  async close(): Promise<void> {}
}

/** Replace `Uint8Array` leaves with the host's pointer form, bounded by the
 *  attribute limits already applied upstream. */
function offloadBytes(value: unknown, encodeBytes: BytesEncoder): void {
  const stack: unknown[] = [value];
  let guard = 0;
  while (stack.length > 0 && guard < 10_000) {
    guard += 1;
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i += 1) {
        const item = current[i];
        if (item instanceof Uint8Array) current[i] = encodeBytes(item);
        else stack.push(item);
      }
      continue;
    }
    const record = current as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const item = record[key];
      if (item instanceof Uint8Array) record[key] = encodeBytes(item);
      else stack.push(item);
    }
  }
}
