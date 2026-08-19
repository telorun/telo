import { InvokeError } from "./invoke-error.js";
import type { DurableRunHandle } from "./durable-run.js";
import type { ResourceHandle } from "./resource-instance.js";

/**
 * Cooperative invocation cancellation — the standard source/token split.
 *
 * A {@link CancellationToken} is the read-only side handed to controllers as the
 * `cancellation` member of the {@link InvokeContext} second argument: poll it
 * (`isCancelled`), subscribe (`onCancelled`), bail (`throwIfCancelled`), or hand
 * its `signal` to a Web API (`fetch`, `streamText`). The writable
 * {@link CancellationSource} behind it — `cancel` / `cancelAt` / `cancelAfter` —
 * is held only by the kernel, embedders, and trigger modules, never by the
 * controllers that observe the token.
 *
 * A deadline is not a separate concept: `cancelAt(epochMs)` arms the token to
 * trip at an instant, so any code holding a deadline schedules a cancellation
 * and every honoring leaf gets timeout behavior for free. `cancelAt` (absolute)
 * is the primitive; `cancelAfter(ms)` is sugar over it.
 */

export const ERR_INVOKE_CANCELLED = "ERR_INVOKE_CANCELLED";

export interface CancellationToken {
  /** Synchronous poll — `true` once the owning source has cancelled. */
  readonly isCancelled: boolean;
  /** Human-readable reason supplied to `cancel`/the deadline, if any. */
  readonly reason: string | undefined;
  /** `AbortSignal` escape hatch for handing off to Web APIs (`fetch`,
   *  `streamText`). Aborts when the source cancels. */
  readonly signal: AbortSignal;
  /** Subscribe to cancellation. Fires immediately if already cancelled.
   *  Returns an unsubscribe function. */
  onCancelled(listener: (reason: string | undefined) => void): () => void;
  /** Throw `ERR_INVOKE_CANCELLED` if cancelled; otherwise no-op. */
  throwIfCancelled(): void;
}

/**
 * One open execution zone — see `kernel/specs/execution-zones.md`. Three
 * identities and nothing else: no provider-private payload rides here (a
 * provider keys its own map on the entry), so the contract stays serializable
 * across the ABI and another module's open transaction is never readable from
 * the ambient stack.
 */
export interface ZoneEntry {
  /** Canonical `<module>.<Kind>` of the providing kind — what a requirement names. */
  readonly kind: string;
  readonly provider: ResourceHandle;
  /** The instance the provider's correlation-key pointer resolved to.
   *  Absent = uncorrelated zone. */
  readonly key?: ResourceHandle;
}

/**
 * The out-of-band second argument every `invoke()` receives. Intentionally an
 * extensible object rather than a bare token so future per-invoke concerns
 * (trace, idempotency) can join without a breaking signature change.
 */
export interface InvokeContext {
  readonly cancellation: CancellationToken;
  /** Monotonic id minted by the kernel for this invocation — present only while
   *  tracing is active (a debug consumer is attached). Lets controllers correlate
   *  their work with the debug stream. */
  readonly invocationId?: number;
  /** The {@link invocationId} of the invocation that dispatched this one, or
   *  `undefined` at a trace root. Reconstructs the call tree on the consumer. */
  readonly parentInvocationId?: number;
  /** The trace this invocation belongs to — minted at the root span and inherited
   *  by every descendant. Present only while tracing. Groups all spans of one
   *  trace the way OpenTelemetry's `trace_id` does (an exporter maps it directly),
   *  independent of the parent chain. */
  readonly traceId?: string;
  /** Zones open around this invocation, outermost first. Absent = none. */
  readonly zones?: readonly ZoneEntry[];
  /**
   * The durable run this invocation is executing inside, when there is one —
   * the replay seam the step engine journals through
   * (`kernel/specs/durable-execution.md`).
   *
   * **Its own member, not a `ZoneEntry` payload.** The durable zone IS a real
   * zone and rides the stack above, but an entry is three identities *because*
   * that keeps it ABI-serializable and stops any controller reading another
   * module's open state off the stack. A run handle is a live object with
   * methods, and hanging it on the entry would trade that property away for
   * every zone, durable or not. The landed payload rule (provider-private state
   * lives on an instance injected across the boundary) cannot carry it either —
   * a nested `Run.Sequence` holds no durable reference, so a sequence two levels
   * down has no injected instance to read from.
   *
   * The consequence, stated rather than implied: unlike {@link zones}, this
   * member does **not** cross the ABI. The kernel is a pure conduit — it carries
   * the handle and never calls it — so a second runtime threads a handle it
   * owns rather than deserializing this one.
   *
   * Picked up by every nested dispatch, which is what makes nesting work with no
   * per-module effort: a nested sequence, in this module or across an import
   * boundary, journals its steps under the outer step's path, so a crash inside
   * it resumes inside it.
   */
  readonly durable?: DurableRunHandle;
  /**
   * The journal path of the step whose dispatch led here, when this invocation
   * is inside a durable run.
   *
   * The other half of carriage, and without it nesting is silently wrong rather
   * than merely unsupported: a nested step body that started its own paths at
   * `steps` would record `steps/<name>` for every body in the run, so two nested
   * bodies with a same-named step share one key. First-writer-wins then hands
   * the second the first's RESULT — and when both dispatch the same target there
   * is no mismatch to detect, so the run continues with a value produced for a
   * different step.
   *
   * A nested engine reads this as the base its own step paths hang under, which
   * is what makes "a crash inside a nested body resumes inside it" true. Absent
   * at the top of a run, where the base is `steps`.
   */
  readonly durablePath?: string;
}

/**
 * The ONE way to build a context derived from another. A fresh object literal
 * at a rebuild site silently drops every field it does not restate — with
 * `zones` that means the stack survives with tracing off and vanishes under
 * `--debug`, a safety property flipping on a debug flag. Every context-rebuild
 * site (the kernel's tracing branches, span derivation) goes through here so a
 * field added to {@link InvokeContext} propagates without each site opting in.
 */
export function deriveContext(base: InvokeContext, overrides: Partial<InvokeContext>): InvokeContext {
  return { ...base, ...overrides };
}

/** Terminal status of a span — maps to OpenTelemetry span status. */
export type SpanOutcome = "ok" | "failed" | "rejected" | "cancelled";

/** Options for {@link ResourceContext.openSpan}. */
export interface OpenSpanOptions {
  /** The resource the span is attributed to (an inbound transport's listener,
   *  e.g. the `Http.Api`). Becomes the span's `ref`. */
  ref: { kind: string; name: string };
  /** Human label for the span (e.g. `"POST /feedback"`). */
  label?: string;
  /** Structured attributes (e.g. `{ method, path }`). Map to OTel span attributes. */
  attributes?: Record<string, unknown>;
  /** Continue an upstream distributed trace instead of rooting a new one — e.g.
   *  seeded from a W3C `traceparent` header. */
  inbound?: { traceId: string; parentSpanId?: number };
}

/** Handle returned by {@link ResourceContext.openSpan}. */
export interface OpenSpan {
  /** Thread into `invokeResolved` so the handler nests under the span. */
  readonly context: InvokeContext;
  /** Close the span with an outcome (emits the span's `end` event). */
  settle(outcome: SpanOutcome, detail?: Record<string, unknown>): Promise<void>;
}

export interface CancellationSource {
  readonly token: CancellationToken;
  /** The {@link InvokeContext} wrapping this source's token — pass to
   *  `invokeResolved(..., source.context)` to seed an invocation tree. */
  readonly context: InvokeContext;
  cancel(reason?: string): void;
  /** Arm cancellation at an absolute epoch-millis instant (a deadline). */
  cancelAt(epochMs: number): void;
  /** Sugar over `cancelAt(now + ms)`. */
  cancelAfter(ms: number): void;
  /** Release a pending deadline timer and subscribers without cancelling.
   *  Triggers that arm `cancelAt` (lambda deadline, embedder `deadlineAt`) call
   *  this in a `finally` once the invoke settles, so an early finish doesn't pin
   *  the source + timer alive until the deadline. Idempotent. */
  dispose(): void;
}

class CancellationTokenSource implements CancellationSource {
  readonly #controller = new AbortController();
  #cancelled = false;
  #reason: string | undefined;
  readonly #listeners = new Set<(reason: string | undefined) => void>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly token: CancellationToken;
  readonly context: InvokeContext;

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const source = this;
    this.token = {
      get isCancelled() {
        return source.#cancelled;
      },
      get reason() {
        return source.#reason;
      },
      get signal() {
        return source.#controller.signal;
      },
      onCancelled(listener) {
        if (source.#cancelled) {
          listener(source.#reason);
          return () => {};
        }
        source.#listeners.add(listener);
        return () => source.#listeners.delete(listener);
      },
      throwIfCancelled() {
        if (source.#cancelled) {
          throw new InvokeError(ERR_INVOKE_CANCELLED, source.#reason ?? "Invoke cancelled");
        }
      },
    };
    this.context = { cancellation: this.token };
  }

  cancel(reason?: string): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#reason = reason;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#controller.abort(reason);
    const listeners = [...this.#listeners];
    this.#listeners.clear();
    for (const listener of listeners) listener(reason);
  }

  cancelAt(epochMs: number): void {
    if (this.#cancelled) return;
    const delay = epochMs - Date.now();
    if (delay <= 0) {
      this.cancel("deadline-exceeded");
      return;
    }
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.cancel("deadline-exceeded"), delay);
    // Don't keep the process alive solely for a pending deadline timer.
    (this.#timer as { unref?: () => void }).unref?.();
  }

  cancelAfter(ms: number): void {
    this.cancelAt(Date.now() + ms);
  }

  dispose(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#listeners.clear();
  }
}

export function createCancellationSource(): CancellationSource {
  return new CancellationTokenSource();
}

// Shared never-aborting signal for the sentinel token, so the common dispatch
// path allocates no AbortController for invokes that never touch cancellation.
const neverController = new AbortController();

/** A token that is never cancelled — the sentinel used by the kernel's hot
 *  dispatch path when no source has been seeded for an invocation tree. */
export const NEVER_CANCELLED: CancellationToken = {
  isCancelled: false,
  reason: undefined,
  get signal() {
    return neverController.signal;
  },
  onCancelled() {
    return () => {};
  },
  throwIfCancelled() {},
};

/** The shared {@link InvokeContext} carrying {@link NEVER_CANCELLED}. */
export const UNCANCELLABLE_CONTEXT: InvokeContext = { cancellation: NEVER_CANCELLED };

/** Recognizes the cancellation error by code, dual-realm safe (no `instanceof`). */
export function isCancellationError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === ERR_INVOKE_CANCELLED
  );
}
