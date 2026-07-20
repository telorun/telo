import { closeSync, openSync, writeSync } from "node:fs";
import type { LogRecord } from "@telorun/sdk";
import { encodeJsonLine, type BytesEncoder } from "./encode-json.js";
import { encodePrettyLine } from "./encode-pretty.js";
import { DEFAULT_BUFFER_POLICY, type LogSinkInstance, type SinkBufferPolicy } from "./log-sink.js";
import { RecordBuffer } from "./record-buffer.js";

/**
 * `Telo.FileSink` — a kernel built-in (§10.2). Asynchronous, `json` by default.
 *
 * Sync-flushable: a positional write is available on every target platform, so a
 * `fatal` record is durable by the time `log()` returns. That is what makes the
 * file sink a legitimate audit destination while an OTLP sink is not — delivery
 * there is a network round-trip that cannot complete without yielding.
 */

export type FileEncoding = "json" | "pretty";

export interface FileSinkOptions {
  sinkId: string;
  level: number;
  destination: string;
  encoding?: FileEncoding;
  policy?: SinkBufferPolicy;
  onDrop: () => void;
  encodeBytes?: BytesEncoder;
}

export class FileSink implements LogSinkInstance {
  readonly sinkId: string;
  readonly level: number;
  readonly syncFlushable = true;

  readonly #buffer: RecordBuffer;
  readonly #encode: (record: LogRecord) => string;
  readonly #fd: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(options: FileSinkOptions) {
    this.sinkId = options.sinkId;
    this.level = options.level;
    const policy = options.policy ?? DEFAULT_BUFFER_POLICY;
    this.#buffer = new RecordBuffer(policy, options.onDrop);
    const encoding = options.encoding ?? "json";
    this.#encode =
      encoding === "pretty"
        ? (record) => encodePrettyLine(record, { color: false })
        : (record) => encodeJsonLine(record, { encodeBytes: options.encodeBytes });

    this.#fd = openSync(options.destination, "a");

    this.#timer = setInterval(() => this.flushSync(), policy.flushIntervalMs);
    // A pending flush tick must never be the reason a process stays alive; the
    // shutdown flush is what guarantees the tail is written.
    (this.#timer as { unref?: () => void }).unref?.();
  }

  write(record: LogRecord): void {
    if (this.#closed) return;
    this.#buffer.push(record);
  }

  async flush(): Promise<void> {
    this.flushSync();
  }

  flushSync(): void {
    if (this.#closed) return;
    const records = this.#buffer.drain();
    if (records.length === 0) return;
    let payload = "";
    for (const record of records) payload += this.#encode(record);
    writeSync(this.#fd, payload);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.flushSync();
    this.#closed = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    closeSync(this.#fd);
  }
}
