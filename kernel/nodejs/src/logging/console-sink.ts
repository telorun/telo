import type { LogRecord } from "@telorun/sdk";
import { decideColor, type ColorSetting } from "./color-precedence.js";
import { encodeJsonLine, type BytesEncoder } from "./encode-json.js";
import { encodePrettyLine } from "./encode-pretty.js";
import type { LogSinkInstance } from "./log-sink.js";

/**
 * `Telo.ConsoleSink` — a kernel built-in (§10.2).
 *
 * Console and file are built-ins rather than standard-library modules because
 * §16 already requires every conforming runtime to implement both, along with
 * the `pretty` and `json` encodings, byte-identically. Mandatory runtime
 * behaviour belongs in the runtime; shipping it as an installable module would
 * make conformance depend on whether that module happened to be installed.
 *
 * Synchronous by default: a developer-facing stream that silently reorders or
 * drops is worse than a slow one, and `on_full` does not apply to a sink with no
 * buffer to saturate.
 */

export type ConsoleEncoding = "auto" | "pretty" | "json";
export type ConsoleDestination = "stderr" | "stdout";

export interface ConsoleSinkOptions {
  sinkId: string;
  level: number;
  destination?: ConsoleDestination;
  encoding?: ConsoleEncoding;
  color?: ColorSetting;
  /** The host environment — capability signals only, never a config channel. */
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  encodeBytes?: BytesEncoder;
}

export class ConsoleSink implements LogSinkInstance {
  readonly sinkId: string;
  readonly level: number;
  /** A file-descriptor write blocks until the bytes are handed to the OS, so a
   *  `fatal` record is durable by the time `log()` returns (§10.5). */
  readonly syncFlushable = true;

  readonly #stream: NodeJS.WritableStream;
  readonly #pretty: boolean;
  readonly #color: boolean;
  readonly #encodeBytes: BytesEncoder | undefined;

  constructor(options: ConsoleSinkOptions) {
    this.sinkId = options.sinkId;
    this.level = options.level;
    const destination = options.destination ?? "stderr";
    this.#stream = destination === "stdout" ? options.stdout : options.stderr;

    // `auto` is evaluated against *this sink's* destination descriptor, not the
    // process's: a console sink on stdout and another on stderr can resolve
    // differently, and that is correct.
    const isTTY = Boolean((this.#stream as { isTTY?: boolean }).isTTY);
    const encoding = options.encoding ?? "auto";
    this.#pretty = encoding === "pretty" || (encoding === "auto" && isTTY);
    this.#color = this.#pretty
      ? decideColor({ setting: options.color ?? "auto", env: options.env, isTTY })
      : false;
    this.#encodeBytes = options.encodeBytes;
  }

  write(record: LogRecord): void {
    this.#stream.write(
      this.#pretty
        ? encodePrettyLine(record, { color: this.#color })
        : encodeJsonLine(record, { encodeBytes: this.#encodeBytes }),
    );
  }

  async flush(): Promise<void> {
    // Nothing is held: every record is handed to the descriptor on write.
  }

  flushSync(): void {
    // Same — the write already reached the OS.
  }

  async close(): Promise<void> {
    // The process owns stdout/stderr; a sink never closes them.
  }
}
