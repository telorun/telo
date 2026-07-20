import type { ErrorValue } from "@telorun/sdk";

/**
 * Normalize any thrown value into the record's structured error —
 * `kernel/specs/logging.md` §4.2.
 *
 * The `cause` chain is bounded per §6.3 and the truncation is *recorded* rather
 * than silently applied, so a reader can tell a chain was cut from one that
 * simply ended.
 */

const MAX_CAUSE_DEPTH = 10;

export function toErrorValue(thrown: unknown, maxDepth = MAX_CAUSE_DEPTH): ErrorValue {
  const seen = new Set<unknown>();
  let depth = 0;
  let current: unknown = thrown;

  const root = shallowErrorValue(current);
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
    const next = shallowErrorValue(cause);
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

function shallowErrorValue(thrown: unknown): ErrorValue {
  if (thrown instanceof Error) {
    const code = (thrown as { code?: unknown }).code;
    return {
      type: typeof code === "string" && code.length > 0 ? code : thrown.name,
      message: thrown.message,
      ...(thrown.stack ? { stack: thrown.stack } : {}),
    };
  }

  if (typeof thrown === "object" && thrown !== null) {
    const record = thrown as { code?: unknown; name?: unknown; message?: unknown; stack?: unknown };
    const type =
      typeof record.code === "string"
        ? record.code
        : typeof record.name === "string"
          ? record.name
          : "Error";
    const message =
      typeof record.message === "string" ? record.message : safeStringify(thrown);
    return {
      type,
      message,
      ...(typeof record.stack === "string" ? { stack: record.stack } : {}),
    };
  }

  return { type: typeof thrown === "string" ? "Error" : typeof thrown, message: String(thrown) };
}

function causeOf(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const cause = (value as { cause?: unknown }).cause;
  return cause === undefined || cause === null ? undefined : cause;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
