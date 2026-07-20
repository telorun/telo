import { severityFloor, type AnyValue, type ErrorValue, type LogRecord } from "@telorun/sdk";

/**
 * The `pretty` encoding — `kernel/specs/logging.md` §11.2. For humans on a
 * terminal:
 *
 *     12:34:56.789 INFO  Http.Server.api  listening  net.host.port=8080
 *
 * The color table is a modal synthesis across pino-pretty, zap, tint,
 * tracing-subscriber, consola, and winston, which do not fully agree — zap alone
 * uses magenta for DEBUG and blue for INFO, and TRACE has no consensus. It is a
 * deliberate choice, not a standard.
 */

const RESET = "\u001b[0m";

const LEVEL_COLOR: Readonly<Record<number, string>> = {
  1: "\u001b[2m", // TRACE — dim
  5: "\u001b[34m", // DEBUG — blue
  9: "\u001b[32m", // INFO — green
  13: "\u001b[33m", // WARN — yellow
  17: "\u001b[31m", // ERROR — red
  21: "\u001b[1;41m", // FATAL — bold, red background
};

const DIM = "\u001b[2m";

export interface PrettyEncodeOptions {
  color: boolean;
}

export function encodePrettyLine(record: LogRecord, options: PrettyEncodeOptions): string {
  return `${encodePretty(record, options)}\n`;
}

export function encodePretty(record: LogRecord, options: PrettyEncodeOptions): string {
  const paint = options.color
    ? (code: string, text: string) => `${code}${text}${RESET}`
    : (_code: string, text: string) => text;

  const parts: string[] = [
    formatLocalTime(record.timestamp),
    paint(LEVEL_COLOR[severityFloor(record.severityNumber)]!, record.severityText.padEnd(5)),
  ];

  if (record.resource) parts.push(`${record.resource.kind}.${record.resource.name}`);

  // The message itself is never colored by level — only the level token is.
  parts.push(record.message);

  const attributes = record.attributes;
  if (attributes) {
    for (const [key, value] of Object.entries(attributes)) {
      parts.push(`${paint(DIM, key)}=${formatAttributeValue(value)}`);
    }
  }

  if (record.droppedAttributesCount) {
    parts.push(`${paint(DIM, "dropped_attributes_count")}=${record.droppedAttributesCount}`);
  }

  let line = parts.join("  ");

  if (record.error) line += `\n${formatError(record.error, paint)}`;

  return line;
}

/** `HH:MM:ss.SSS`, local timezone. Millisecond resolution: the sub-millisecond
 *  digits of the record's nanosecond timestamp are noise on a console line. */
function formatLocalTime(timestamp: bigint): string {
  const date = new Date(Number(timestamp / 1_000_000n));
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatAttributeValue(value: AnyValue): string {
  if (value === null) return "null";
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  if (typeof value === "object") return quoteIfNeeded(JSON.stringify(value, jsonSafe));
  return quoteIfNeeded(String(value));
}

/** Values containing whitespace, `"`, or `=` must be quoted so the `key=value`
 *  stream stays unambiguously parseable by eye. */
function quoteIfNeeded(text: string): string {
  return /[\s"=]/.test(text) ? JSON.stringify(text) : text;
}

function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  return value;
}

/** Errors render after the message; the stack goes on following lines,
 *  indented, unmodified. The `cause` chain follows, already bounded by §6.3. */
function formatError(error: ErrorValue, paint: (code: string, text: string) => string): string {
  const lines: string[] = [`  ${paint(LEVEL_COLOR[17]!, error.type)}: ${error.message}`];
  if (error.stack) {
    for (const line of error.stack.split("\n")) lines.push(`    ${line}`);
  }
  let cause = error.cause;
  let guard = 0;
  while (cause && guard < 16) {
    lines.push(`  ${paint(DIM, "caused by")} ${cause.type}: ${cause.message}`);
    if (cause.stack) {
      for (const line of cause.stack.split("\n")) lines.push(`    ${line}`);
    }
    cause = cause.cause;
    guard += 1;
  }
  return lines.join("\n");
}
