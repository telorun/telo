import type { InvokeContext } from "@telorun/sdk";
import {
  UNCANCELLABLE_CONTEXT,
  createCancellationSource,
  deriveContext,
  isSuspension,
} from "@telorun/sdk";

/**
 * The module's one bounded runner: work items run side by side up to a limit,
 * under one cancellation scope. The agents' tool calls and an operation's
 * content resolutions both run through it, so the two cannot drift on the
 * bound, on what a failure does to the work beside it, or on what cancelling
 * the invocation reaches.
 */

/** Why the runner cancels the work still running. */
export interface BoundedReasons {
  /** An item failed. */
  siblingFailed: string;
  /** The consumer stopped reading before the items finished. */
  abandoned: string;
}

/** What the runner yields: a finished item with its position among the items it
 *  was given, or something a running item reported before it finished. */
export type BoundedStep<R, E> = { index: number; outcome: R } | { event: E };

type Settled<R> = { index: number; outcome: R } | { index: number; error: unknown };

/**
 * Run `items` through `dispatch`, at most `limit` at a time, started in order,
 * yielding each outcome as its item completes. An item may `report` events
 * while it runs; each is yielded as soon as it is reported, ahead of that
 * item's outcome.
 *
 * `dispatch` throws only what must end the run. The first such failure cancels
 * the items still running and starts no further one; once they have settled,
 * it is what this rejects with. A suspension is not a failure: the items beside
 * it finish, no further one starts, and the suspension is raised after them —
 * unless one of them failed, which wins. A cancellation of `ctx` starts no
 * further item and is raised once the running ones have settled.
 *
 * Items running side by side do so under a cancellation scope of their own,
 * linked to `ctx`, so cancelling the invocation reaches every one. So does an
 * item that `reports`: a consumer may stop reading at its event while it still
 * runs. One item at a time that reports nothing needs no scope and runs on
 * `ctx` itself.
 */
export async function* runBounded<T, R, E = never>(
  items: readonly T[],
  limit: number,
  ctx: InvokeContext | undefined,
  reasons: BoundedReasons,
  dispatch: (
    item: T,
    ctx: InvokeContext | undefined,
    report: (event: E) => void,
  ) => Promise<R>,
  reports = false,
): AsyncGenerator<BoundedStep<R, E>> {
  const width = Math.max(1, Math.min(limit, items.length));
  const source = width > 1 || reports ? createCancellationSource() : undefined;
  const scoped = source
    ? deriveContext(ctx ?? UNCANCELLABLE_CONTEXT, { cancellation: source.token })
    : ctx;
  const unlink = source
    ? ctx?.cancellation.onCancelled((reason) => source.cancel(reason))
    : undefined;
  const cancelled = () =>
    source ? source.token.isCancelled : ctx?.cancellation.isCancelled === true;
  const running = new Map<number, Promise<Settled<R>>>();
  const events: E[] = [];
  let wake: (() => void) | undefined;
  const report = (event: E) => {
    events.push(event);
    wake?.();
  };
  let next = 0;
  let failure: { error: unknown } | undefined;
  let parked: { error: unknown } | undefined;
  try {
    for (;;) {
      while (!failure && !parked && !cancelled() && next < items.length && running.size < width) {
        const index = next++;
        running.set(
          index,
          dispatch(items[index]!, scoped, report).then(
            (outcome): Settled<R> => ({ index, outcome }),
            (error): Settled<R> => ({ index, error }),
          ),
        );
      }
      // Drained before any outcome is awaited, so an item's events precede it.
      while (events.length > 0) {
        const event = events.shift()!;
        if (!failure) yield { event };
      }
      if (running.size === 0) break;
      const woken = new Promise<undefined>((resolve) => {
        wake = () => resolve(undefined);
      });
      const settled = await Promise.race([...running.values(), woken]);
      wake = undefined;
      if (!settled) continue;
      running.delete(settled.index);
      if ("error" in settled) {
        if (isSuspension(settled.error)) {
          parked ??= settled;
        } else if (!failure) {
          failure = settled;
          source?.cancel(reasons.siblingFailed);
        }
      } else if (!failure) {
        yield settled;
      }
    }
    if (failure) throw failure.error;
    if (parked) throw parked.error;
    ctx?.cancellation.throwIfCancelled();
  } finally {
    unlink?.();
    // Reached with items in flight only when the consumer stopped reading.
    if (running.size > 0) {
      source?.cancel(reasons.abandoned);
      await Promise.all(running.values());
    }
    source?.dispose();
  }
}
