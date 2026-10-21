/**
 * What the core refuses, and how it says so. Reading and checking answer a list of
 * problems, each at a path inside the data that was read (and, for a pattern, a range
 * of UTF-16 code units inside its text); formatting throws one `MessageFormatError`.
 * Every message is worded identically by the Rust core.
 */

export type MessageCode =
  | "MESSAGE_SYNTAX_INVALID"
  | "MESSAGE_PLURAL_CATEGORY_INVALID"
  | "MESSAGE_PLACEHOLDER_UNKNOWN"
  | "MESSAGE_PLACEHOLDER_UNBOUND"
  | "MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED";

/** A half-open `[start, end)` span of UTF-16 code units. */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

export interface MessageProblem {
  readonly code: MessageCode;
  readonly message: string;
  /** Keys from the value that was read down to the node at fault. */
  readonly path: readonly string[];
  /** Where inside a pattern's text; `null` when the node as a whole is at fault. */
  readonly range: SourceRange | null;
}

export class MessageFormatError extends Error {
  readonly code: MessageCode;

  constructor(code: MessageCode, message: string) {
    super(message);
    this.name = "MessageFormatError";
    this.code = code;
  }
}

export function syntaxProblem(message: string, path: readonly string[], range: SourceRange | null = null): MessageProblem {
  return { code: "MESSAGE_SYNTAX_INVALID", message, path, range };
}
