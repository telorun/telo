import { failureFrameLine, failureFramesOf, droppedFramesOf } from "./failure-trace.js";
import type { ErrorValue } from "./log-record.js";
import { holdsSensitiveMember } from "./value-type.js";

/**
 * Normalize any thrown value into the record's structured error —
 * `kernel/specs/logging.md` §4.2: its type, message, Telo trace (`frames` and the
 * `stack` text built from them) and, for an uncoded failure only, the host stack.
 *
 * The `cause` chain is bounded per §6.3 and the truncation is *recorded* rather
 * than silently applied, so a reader can tell a chain was cut from one that simply
 * ended.
 */

const MAX_CAUSE_DEPTH = 10;

export interface ErrorValueOptions {
  /** Replaces every value holding a member its type declares sensitive (§14). */
  censor?: string;
  maxDepth?: number;
  /** How a frame's module is shown in `stack`; the module's source as is by default. */
  file?: (module: string) => string;
}

export function errorValueOf(thrown: unknown, options: ErrorValueOptions = {}): ErrorValue {
  const censor = options.censor ?? "[redacted]";
  const maxDepth = options.maxDepth ?? MAX_CAUSE_DEPTH;
  const seen = new Set<unknown>();
  let depth = 0;
  let current: unknown = thrown;

  const root = shallowErrorValue(current, censor, options.file);
  let tail = root;
  seen.add(current);

  while (depth < maxDepth) {
    const cause = causeOf(current);
    if (cause === undefined) return root;
    if (seen.has(cause)) {
      tail.cause = { type: "ERR_CAUSE_CYCLE", message: "cause chain refers to itself" };
      return root;
    }
    seen.add(cause);
    const next = shallowErrorValue(cause, censor, options.file);
    tail.cause = next;
    tail = next;
    current = cause;
    depth += 1;
  }

  if (causeOf(current) !== undefined) {
    tail.cause = {
      type: "ERR_CAUSE_CHAIN_TRUNCATED",
      message: `cause chain truncated at ${maxDepth} entries`,
    };
  }
  return root;
}

function shallowErrorValue(
  thrown: unknown,
  censor: string,
  file: ((module: string) => string) | undefined,
): ErrorValue {
  if (typeof thrown === "object" && thrown !== null) {
    const record = thrown as { code?: unknown; name?: unknown; message?: unknown; stack?: unknown; hostStack?: unknown };
    const code = typeof record.code === "string" && record.code.length > 0 ? record.code : undefined;
    const type = code ?? (typeof record.name === "string" ? record.name : thrown instanceof Error ? thrown.name : "Error");
    const message =
      typeof record.message === "string" ? record.message : safeStringify(thrown, censor);
    // A coded failure is a refusal a manifest describes; an uncoded one (or ERR_FATAL)
    // is a bug in controller or kernel code, where the host stack is the finding. A
    // host stack a controller's SDK reported (a panic arrives coded) is kept whatever the code.
    const hostStack =
      typeof record.hostStack === "string" && record.hostStack !== ""
        ? record.hostStack
        : (code === undefined || code === "ERR_FATAL") && typeof record.stack === "string"
          ? record.stack
          : undefined;
    const frames = failureFramesOf(thrown);
    const dropped = droppedFramesOf(thrown);
    return {
      type,
      message,
      ...(frames.length > 0
        ? {
            stack: frames
              .map((frame) => failureFrameLine(frame, frame.module === undefined ? undefined : (file?.(frame.module) ?? frame.module)))
              .join("\n"),
            frames: frames.map((frame) => ({ ...frame })),
          }
        : {}),
      ...(dropped > 0 ? { droppedFramesCount: dropped } : {}),
      ...(hostStack ? { hostStack } : {}),
    };
  }

  return { type: typeof thrown === "string" ? "Error" : typeof thrown, message: String(thrown) };
}

function causeOf(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const cause = (value as { cause?: unknown }).cause;
  return cause === undefined || cause === null ? undefined : cause;
}

function safeStringify(value: unknown, censor: string): string {
  try {
    return (
      JSON.stringify(value, (_key, held) => (holdsSensitiveMember(held) ? censor : held)) ?? String(value)
    );
  } catch {
    return String(value);
  }
}
