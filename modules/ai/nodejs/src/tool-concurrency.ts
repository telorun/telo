import type { InvokeContext } from "@telorun/sdk";
import {
  UNCANCELLABLE_CONTEXT,
  createCancellationSource,
  deriveContext,
  isSuspension,
} from "@telorun/sdk";
import type { ToolCall } from "./types.js";

/**
 * How the tool calls of one model response run: side by side, up to the agent's
 * `maxParallelTools`. Shared by `Ai.Agent` and `Ai.AgentStream`, so the two
 * cannot drift on the bound, on what a failure does to the calls beside it, or
 * on what cancelling the turn reaches.
 */

export const DEFAULT_MAX_PARALLEL_TOOLS = 4;

/** The configured bound as a number (a CEL-computed one arrives as an int64). */
export function parallelToolLimit(value: unknown, label: string): number {
  if (value === undefined) return DEFAULT_MAX_PARALLEL_TOOLS;
  const limit = typeof value === "bigint" ? Number(value) : value;
  if (typeof limit === "number" && Number.isInteger(limit) && limit >= 1) return limit;
  throw new Error(`${label}: 'maxParallelTools' must be an integer of at least 1, got ${String(value)}.`);
}

/** What the runner yields: a finished call with its position among the calls it
 *  was given, or something a running call reported before it finished. */
export type ToolCallStep<R, E> = { index: number; outcome: R } | { event: E };

type Settled<R> = { index: number; outcome: R } | { index: number; error: unknown };

const SIBLING_FAILED = "a tool call of the same model response failed";
const ABANDONED = "the run stopped before its tool calls finished";

/**
 * Run `calls` through `dispatch`, at most `limit` at a time, started in call
 * order, yielding each outcome as its call completes. A call may `report`
 * events while it runs; each is yielded as soon as it is reported, ahead of
 * that call's outcome.
 *
 * `dispatch` throws only what must end the run — a tool failure under
 * `onToolError: throw`, a failed approval ask, a cancellation, a durable
 * suspension. The first such failure cancels the calls still running and starts
 * no further one; once they have settled, it is what this rejects with. A
 * suspension is not a failure: the calls beside it finish, no further one
 * starts, and the suspension is raised after them — unless one of them failed,
 * which wins.
 *
 * Calls running side by side do so under a cancellation scope of their own,
 * linked to `ctx`, so cancelling the turn reaches every one. So does a call
 * that `reports`: a consumer may stop reading at its event while it still runs.
 * One call at a time that reports nothing needs no scope and runs on `ctx` itself.
 */
export async function* runToolCalls<R, E = never>(
  calls: readonly ToolCall[],
  limit: number,
  ctx: InvokeContext | undefined,
  dispatch: (
    call: ToolCall,
    ctx: InvokeContext | undefined,
    report: (event: E) => void,
  ) => Promise<R>,
  reports = false,
): AsyncGenerator<ToolCallStep<R, E>> {
  const width = Math.max(1, Math.min(limit, calls.length));
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
      while (!failure && !parked && !cancelled() && next < calls.length && running.size < width) {
        const index = next++;
        running.set(
          index,
          dispatch(calls[index]!, scoped, report).then(
            (outcome): Settled<R> => ({ index, outcome }),
            (error): Settled<R> => ({ index, error }),
          ),
        );
      }
      // Drained before any outcome is awaited, so a call's events precede it.
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
          source?.cancel(SIBLING_FAILED);
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
    // Reached with calls in flight only when the consumer stopped reading.
    if (running.size > 0) {
      source?.cancel(ABANDONED);
      await Promise.all(running.values());
    }
    source?.dispose();
  }
}
