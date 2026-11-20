import { AdvisoryLookupError, LookupCancelledError } from "./advisory-lookup-error.js";

export const MAX_ATTEMPTS = 4;
export const ATTEMPT_TIMEOUT_MS = 30_000;
export const LOOKUP_BUDGET_MS = 120_000;
const BACKOFF_BASE_MS = 500;

export interface LookupRuntime {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
  /** Absolute time (per `now`) the whole lookup must end by. */
  deadline: number;
  /** Aborting it ends the lookup with a `LookupCancelledError`. */
  signal?: AbortSignal;
}

function throwIfCancelled(runtime: LookupRuntime): void {
  if (runtime.signal?.aborted) throw new LookupCancelledError(runtime.signal.reason);
}

async function cancellableSleep(runtime: LookupRuntime, ms: number): Promise<void> {
  const signal = runtime.signal;
  if (signal === undefined) return runtime.sleep(ms);
  throwIfCancelled(runtime);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new LookupCancelledError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([runtime.sleep(ms), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (header.trim() !== "" && Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const inner = cause instanceof Error ? cause.message : undefined;
    return inner && !error.message.includes(inner) ? `${error.message} (${inner})` : error.message;
  }
  return String(error);
}

/** One OSV request with the lookup's retry policy; resolves to the parsed JSON body. */
export async function osvRequest(
  runtime: LookupRuntime,
  url: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<unknown> {
  let detail = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    throwIfCancelled(runtime);
    const remaining = runtime.deadline - runtime.now();
    if (remaining <= 0) {
      throw new AdvisoryLookupError(url, attempt - 1, `the ${LOOKUP_BUDGET_MS / 1000} s limit for the whole lookup was reached (last failure: ${detail})`);
    }
    let waitMs: number | undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(ATTEMPT_TIMEOUT_MS, remaining));
    try {
      const response = await runtime.fetch(url, {
        method: init.method,
        headers: init.body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: runtime.signal ? AbortSignal.any([controller.signal, runtime.signal]) : controller.signal,
      });
      if (response.ok) {
        try {
          return await response.json();
        } catch (error) {
          throwIfCancelled(runtime);
          throw new AdvisoryLookupError(url, attempt, `the answer is not JSON (${describeFailure(error)})`, { cause: error });
        }
      }
      const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
      if (response.status !== 429 && response.status < 500) {
        throw new AdvisoryLookupError(url, attempt, status);
      }
      detail = status;
      waitMs = retryAfterMs(response.headers.get("retry-after"), runtime.now());
    } catch (error) {
      if (error instanceof AdvisoryLookupError || error instanceof LookupCancelledError) throw error;
      throwIfCancelled(runtime);
      detail = controller.signal.aborted ? `no answer within ${Math.min(ATTEMPT_TIMEOUT_MS, remaining) / 1000} s` : describeFailure(error);
    } finally {
      clearTimeout(timer);
    }
    if (attempt === MAX_ATTEMPTS) break;
    const backoff = BACKOFF_BASE_MS * 2 ** (attempt - 1) * (0.5 + runtime.random());
    const wait = waitMs ?? backoff;
    if (wait >= runtime.deadline - runtime.now()) {
      throw new AdvisoryLookupError(url, attempt, `${detail}; the server asked for a wait beyond the ${LOOKUP_BUDGET_MS / 1000} s limit for the whole lookup`);
    }
    await cancellableSleep(runtime, wait);
  }
  throw new AdvisoryLookupError(url, MAX_ATTEMPTS, detail);
}
