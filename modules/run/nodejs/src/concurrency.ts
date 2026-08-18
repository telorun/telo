import { InvokeError, type ResourceContext } from "@telorun/sdk";

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
 *  first error propagates (in-flight items settle but their results are dropped). */
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
  let failure: { err: unknown } | undefined;

  async function worker(): Promise<void> {
    while (failure === undefined) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        if (failure === undefined) failure = { err };
        return;
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (failure !== undefined) throw failure.err;
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
  let failure: { err: unknown } | undefined;
  let turn: Promise<void> = Promise.resolve();

  async function pull(): Promise<{ item: I; index: number } | undefined> {
    const previous = turn;
    let release!: () => void;
    turn = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      if (done || failure !== undefined) return undefined;
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
    while (failure === undefined) {
      const pulled = await pull();
      if (pulled === undefined) return;
      try {
        await fn(pulled.item, pulled.index);
      } catch (err) {
        if (failure === undefined) failure = { err };
        return;
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: limit }, () => worker()));
  } finally {
    if (!done) await iterator.return?.(undefined);
  }
  if (failure !== undefined) throw failure.err;
}
