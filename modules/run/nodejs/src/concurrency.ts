import { InvokeError, isSuspension, type ResourceContext } from "@telorun/sdk";

/** Bounded fan-out: how `Run.Iteration` and `Run.Projection` run a body over
 *  many elements at a chosen `concurrency`. A composition over the step grammar,
 *  not part of it — the engine runs one body, this decides how many at once. */

/** Resolve a `concurrency` field — a raw CEL value (`!cel`) or literal — to a
 *  positive integer. The schema does not auto-eval the field, so the controller
 *  must expand it itself (mirroring Run.Loop's `maxIterations`); reading it raw
 *  leaves a CompiledValue that `mapConcurrent` would turn into zero workers and a
 *  silent `[null, …]`. Defaults to 1 when omitted. */
export function resolveConcurrency(
  ctx: ResourceContext,
  raw: unknown,
  inputs: Record<string, unknown>,
  operationName: string,
): number {
  if (raw === undefined) return 1;
  const resolved = ctx.expandValue(raw, { inputs });
  const value = Number(resolved);
  if (!Number.isInteger(value) || value < 1) {
    throw new InvokeError(
      "INVALID_CONCURRENCY",
      `${operationName}: concurrency must resolve to an integer >= 1, got ${JSON.stringify(resolved)}`,
    );
  }
  return value;
}

/** Map `items` through `fn` with a bounded worker pool. `concurrency` 1 runs
 *  strictly ordered; `>1` runs that many in flight. Results are written by index
 *  so the returned array preserves input order regardless of completion order.
 *  Fail-fast: on the first rejection no further items are scheduled and the
 *  first error propagates (in-flight items settle but their results are dropped).
 *
 *  A SUSPENSION is the exception, and it is a third settlement kind rather than
 *  a failure — see {@link settlement}. */
export async function mapConcurrent<I, O>(
  items: readonly I[],
  concurrency: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    // Defence in depth: callers resolve concurrency to a validated integer. A
    // non-finite value here would zero the worker pool and silently return a
    // sparse array — surface it instead.
    throw new InvokeError(
      "INVALID_CONCURRENCY",
      `mapConcurrent: concurrency must be a positive integer, got ${concurrency}`,
    );
  }
  const results: O[] = new Array(items.length);
  const limit = Math.max(1, Math.floor(concurrency));
  let next = 0;
  const settled = settlement();

  async function worker(): Promise<void> {
    while (!settled.stop()) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        if (settled.record(err)) return;
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  settled.propagate();
  return results;
}

/**
 * Run `fn` over an async iterable with a bounded worker pool, pulling lazily.
 *
 * The counterpart to {@link mapConcurrent} for a source with no length: it
 * cannot pre-size a result array and must not read ahead, because reading ahead
 * is what draining a stream into memory means — the thing a caller chose a
 * stream to avoid. Returns nothing, since a source of unknown size has no result
 * array to build.
 *
 * PULLS ARE SERIALIZED even at high concurrency. An async iterator makes no
 * promise about overlapping `next()` calls and a generator throws on one, so the
 * workers take turns advancing the source while their bodies still overlap —
 * which is where the concurrency actually lives.
 *
 * Fail-fast, and the source is CLOSED on the way out: a stream abandoned without
 * `return()` leaves its producer waiting on a consumer that will never read
 * again, which is a leak rather than a stalled iteration.
 */
export async function forEachConcurrent<I>(
  source: AsyncIterable<I>,
  concurrency: number,
  fn: (item: I, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new InvokeError(
      "INVALID_CONCURRENCY",
      `forEachConcurrent: concurrency must be a positive integer, got ${concurrency}`,
    );
  }
  const iterator = source[Symbol.asyncIterator]();
  const limit = Math.max(1, Math.floor(concurrency));
  let index = 0;
  let done = false;
  const settled = settlement();
  let turn: Promise<void> = Promise.resolve();

  async function pull(): Promise<{ item: I; index: number } | undefined> {
    const previous = turn;
    let release!: () => void;
    turn = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      if (done || settled.stop()) return undefined;
      const next = await iterator.next();
      if (next.done) {
        done = true;
        return undefined;
      }
      return { item: next.value, index: index++ };
    } finally {
      release();
    }
  }

  async function worker(): Promise<void> {
    while (!settled.stop()) {
      const pulled = await pull();
      if (pulled === undefined) return;
      try {
        await fn(pulled.item, pulled.index);
      } catch (err) {
        if (settled.record(err)) return;
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: limit }, () => worker()));
  } finally {
    if (!done) await iterator.return?.(undefined);
  }
  settled.propagate();
}

/**
 * How a fan-out settles: resolved, rejected, and PARKED.
 *
 * Parking is the third kind, and treating it as a rejection would be wrong in a
 * way that would only be discovered in production. A durable run's fan-out —
 * ask five approvers, wait for all — has N branches in flight when one of them
 * parks. Unwinding on that suspension tears the siblings down mid-step, and
 * because a step is journaled on COMPLETION they have no entry: every one of
 * them re-runs whole on resume. Parallel fan-out would be routinely
 * at-least-once, a property this design otherwise reserves for collapsed regions
 * and crash windows, and documents there precisely because it surprises people.
 *
 * So a parked branch settles and its siblings keep running; the region
 * propagates the suspension only once every branch has completed, failed or
 * parked. The right semantics need no new machinery, because a branch's step
 * paths are already deterministic and index-qualified
 * (`importAll/iterate[3]/fetch`) — each branch is ALREADY an independently
 * resumable subtree, so on resume the completed ones replay from the journal,
 * the parked ones resume at their park point, and the unstarted ones start.
 *
 * A branch blocked on I/O therefore DELAYS the park rather than being destroyed
 * by it, which is correct and is not a new limitation: no step can suspend
 * mid-flight anyway, so waiting is strictly better than tearing down.
 *
 * A real failure still fails fast, and still wins over a suspension when both
 * happened: a failure is a verdict on the work, and a run that has one is
 * finished whether or not a sibling was waiting.
 */
function settlement(): {
  /** True once nothing further should be scheduled. */
  stop(): boolean;
  /** Record a settlement; returns true when this worker should stop. */
  record(err: unknown): boolean;
  /** Re-raise whatever the region settled on, if anything. */
  propagate(): void;
} {
  let failure: { err: unknown } | undefined;
  let parked: { err: unknown } | undefined;
  return {
    stop: () => failure !== undefined,
    record(err) {
      if (isSuspension(err)) {
        // The FIRST park is the one propagated. Which one is arbitrary and does
        // not matter: the signal carries a park that is already recorded, and
        // every other parked branch recorded its own under its own path.
        parked ??= { err };
        return false;
      }
      failure ??= { err };
      return true;
    },
    propagate() {
      if (failure !== undefined) throw failure.err;
      if (parked !== undefined) throw parked.err;
    },
  };
}
