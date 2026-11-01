import type { TextRecord } from "./text-record.js";

const INVOKE_ERROR = Symbol.for("telo.InvokeError");

/** Where in a manifest a failure was caused: the resource whose declaration holds
 *  the offending value, the module declaring it, and an RFC 6901 pointer into
 *  that declaration. */
export interface InvokeErrorLocation {
  readonly kind: string;
  readonly name: string;
  readonly module?: string;
  readonly pointer?: string;
}

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
  /** RFC 6901 pointer into the inputs of the dispatch that raised this error,
   *  naming the input the failure is about. Non-enumerable. */
  declare readonly inputPointer?: string;
  /** Where in a manifest the failure was caused; set only through
   *  {@link attachLocation}. Non-enumerable. */
  declare readonly location?: InvokeErrorLocation;

  constructor(
    code: string,
    message: string,
    data?: unknown,
    options?: { cause?: unknown; displayMessage?: TextRecord; inputPointer?: string },
  ) {
    super(message);
    this.name = "InvokeError";
    this.code = code;
    this.data = data;
    if (options?.displayMessage !== undefined) attachDisplayMessage(this, options.displayMessage);
    if (options?.inputPointer !== undefined) {
      Object.defineProperty(this, "inputPointer", {
        value: options.inputPointer,
        enumerable: false,
        writable: false,
        configurable: false,
      });
    }
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

/**
 * Give `err` the place in a manifest its failure was caused, unless it already
 * carries one — the location attached nearest the failure is kept. The kernel
 * calls this where an error leaves a dispatch.
 */
export function attachLocation(err: InvokeError, location: InvokeErrorLocation): void {
  if (err.location !== undefined) return;
  Object.defineProperty(err, "location", {
    value: Object.freeze({ ...location }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

/** Errors whose `inputPointer` was raised by a call no dispatch exit saw, so no
 *  exit holds the inputs it is relative to. */
const strandedPointers = new WeakSet<InvokeError>();

/**
 * Mark the `inputPointer` of an unlocated `err` as unanchorable: a composer that
 * calls an instance directly, outside the kernel's dispatch, has no exit at which
 * the pointer could be read against the inputs it is relative to, and an outer
 * exit would read it against its own. The error itself is unchanged.
 */
export function strandInputPointer(err: unknown): void {
  if (isInvokeError(err) && err.inputPointer !== undefined && err.location === undefined) {
    strandedPointers.add(err);
  }
}

/** The `inputPointer` a dispatch exit may anchor, or undefined when there is
 *  none or it was raised outside any dispatch ({@link strandInputPointer}). */
export function anchorableInputPointer(err: InvokeError): string | undefined {
  return strandedPointers.has(err) ? undefined : err.inputPointer;
}

export function isInvokeError(err: unknown): err is InvokeError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<PropertyKey, unknown>)[INVOKE_ERROR] === true
  );
}
