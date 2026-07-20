import type { DropCause } from "./log-sink.js";

/**
 * Drop accounting — `kernel/specs/logging.md` §10.4.
 *
 * A runtime maintains a monotonic counter of records dropped per sink, per
 * cause. When drops occur and then cease, it emits exactly one `warn` record
 * reporting the count and the cause. **Dropping without accounting is
 * non-conformant** — "nothing is silently lost" is a design principle, not a
 * nice-to-have, so every drop, truncation, and sink failure is counted and
 * surfaced.
 */

/** Sampling drops happen before fan-out, so they are not attributable to any one
 *  sink and are counted against the pipeline itself. */
export const PIPELINE_SINK_ID = "<pipeline>";

/** How long a cause must go quiet before its recovery warning is emitted. */
const QUIESCE_MS = 1000;

interface Counter {
  /** Monotonic across the process lifetime; never reset. */
  total: number;
  /** Total as of the last emitted recovery warning. */
  reported: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface DropReport {
  sinkId: string;
  cause: DropCause;
  /** Records dropped since the previous report. */
  count: number;
  /** Monotonic lifetime total for this (sink, cause) pair. */
  total: number;
}

export class DropRegistry {
  readonly #counters = new Map<string, Counter>();
  readonly #onRecovered: (report: DropReport) => void;
  /** Guards against a recovery warning that itself drops, which would otherwise
   *  re-arm the timer forever. */
  #reporting = false;

  constructor(onRecovered: (report: DropReport) => void) {
    this.#onRecovered = onRecovered;
  }

  record(sinkId: string, cause: DropCause, count = 1): void {
    const key = `${sinkId}\x00${cause}`;
    let counter = this.#counters.get(key);
    if (!counter) {
      counter = { total: 0, reported: 0, timer: undefined };
      this.#counters.set(key, counter);
    }
    // Always count — a drop caused by emitting the recovery warning itself is
    // still a drop, and undercounting it is exactly the silent loss this class
    // exists to prevent.
    counter.total += count;

    // The only thing suppressed while a recovery warning is in flight is the
    // timer re-arm: re-arming here would loop forever (the warning's own drop
    // re-arms the timer, which fires and drops again). The increment above keeps
    // the total honest; the next ordinary drop — or `reportPending` at
    // shutdown — surfaces it, since `total !== reported`.
    if (this.#reporting) return;

    if (counter.timer) clearTimeout(counter.timer);
    counter.timer = setTimeout(() => this.#report(sinkId, cause, counter!), QUIESCE_MS);
    // A pending drop report must never be the reason a process stays alive.
    (counter.timer as { unref?: () => void }).unref?.();
  }

  /** Lifetime total for a (sink, cause) pair. */
  total(sinkId: string, cause: DropCause): number {
    return this.#counters.get(`${sinkId}\x00${cause}`)?.total ?? 0;
  }

  /** Emit any outstanding reports immediately — used at shutdown so a run that
   *  ends while still dropping does not lose its final accounting. */
  reportPending(): void {
    for (const [key, counter] of this.#counters) {
      if (counter.total === counter.reported) continue;
      const [sinkId, cause] = key.split("\x00") as [string, DropCause];
      this.#report(sinkId, cause, counter);
    }
  }

  dispose(): void {
    for (const counter of this.#counters.values()) {
      if (counter.timer) clearTimeout(counter.timer);
      counter.timer = undefined;
    }
  }

  #report(sinkId: string, cause: DropCause, counter: Counter): void {
    counter.timer = undefined;
    const count = counter.total - counter.reported;
    if (count <= 0) return;
    counter.reported = counter.total;
    this.#reporting = true;
    try {
      this.#onRecovered({ sinkId, cause, count, total: counter.total });
    } finally {
      this.#reporting = false;
    }
  }
}
