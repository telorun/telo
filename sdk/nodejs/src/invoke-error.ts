import type { TextRecord } from "./text-record.js";

const INVOKE_ERROR = Symbol.for("telo.InvokeError");

/**
 * Structured, catchable error for invocables and runnables. Route handlers and
 * Run.Sequence try/catch match on `code`; downstream renderers consume `data`
 * and `displayMessage` — the text a person is shown, as its record, whose
 * values are `data`. `message` is the developer's, for logs and traces.
 *
 * Use `isInvokeError` for recognition, not `instanceof` — dual-realm safe
 * across pnpm hoist splits, registry modules, and future sandbox isolation.
 */
export class InvokeError extends Error {
  readonly code: string;
  readonly data?: unknown;
  // Declared, never initialized: an error with none has no `displayMessage` member.
  declare readonly displayMessage?: TextRecord;

  constructor(
    code: string,
    message: string,
    data?: unknown,
    options?: { cause?: unknown; displayMessage?: TextRecord },
  ) {
    super(message);
    this.name = "InvokeError";
    this.code = code;
    this.data = data;
    if (options?.displayMessage !== undefined) attachDisplayMessage(this, options.displayMessage);
    // Set via defineProperty (not a class field initializer) so the marker is
    // always present regardless of TS/runtime class-field semantics
    // (useDefineForClassFields, Error-subclass quirks, etc.) and stays
    // non-enumerable so JSON serialisation / CEL property access don't trip
    // over it.
    Object.defineProperty(this, INVOKE_ERROR, {
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    // Preserve the error being wrapped. Defined rather than assigned so it is
    // non-enumerable — matching how the Error constructor's own `cause` option
    // behaves, and keeping it out of JSON serialisation / CEL property access
    // for the same reason as the marker above. (`ErrorOptions` is not in this
    // package's TS lib, hence the local option type.)
    if (options && "cause" in options) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
  }
}

/**
 * Give `err` the text a person is shown for it, unless it already carries one —
 * a display message attached nearer the failure is never replaced. The kernel
 * calls this where an error leaves a dispatch whose kind declares the code with
 * a `displayMessage`.
 */
export function attachDisplayMessage(err: InvokeError, displayMessage: TextRecord): void {
  if (err.displayMessage !== undefined) return;
  Object.defineProperty(err, "displayMessage", {
    value: displayMessage,
    enumerable: true,
    writable: false,
    configurable: false,
  });
}

export function isInvokeError(err: unknown): err is InvokeError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<PropertyKey, unknown>)[INVOKE_ERROR] === true
  );
}
