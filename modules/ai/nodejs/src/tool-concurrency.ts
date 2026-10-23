import type { InvokeContext } from "@telorun/sdk";
import { runBounded, type BoundedStep } from "./bounded-runner.js";
import type { ToolCall } from "./types.js";

/**
 * How the tool calls of one model response run: side by side, up to the agent's
 * `maxParallelTools`, through the module's bounded runner. Shared by `Ai.Agent`
 * and `Ai.AgentStream`, so the two cannot drift on the bound, on what a failure
 * does to the calls beside it, or on what cancelling the turn reaches.
 */

export const DEFAULT_MAX_PARALLEL_TOOLS = 4;

/** The configured bound as a number (a CEL-computed one arrives as an int64). */
export function parallelToolLimit(value: unknown, label: string): number {
  if (value === undefined) return DEFAULT_MAX_PARALLEL_TOOLS;
  const limit = typeof value === "bigint" ? Number(value) : value;
  if (typeof limit === "number" && Number.isInteger(limit) && limit >= 1) return limit;
  throw new Error(`${label}: 'maxParallelTools' must be an integer of at least 1, got ${String(value)}.`);
}

const REASONS = {
  siblingFailed: "a tool call of the same model response failed",
  abandoned: "the run stopped before its tool calls finished",
};

/**
 * Run `calls` through `dispatch`, at most `limit` at a time, started in call
 * order — the bounded runner's contract. `dispatch` throws only what must end
 * the run: a tool failure under `onToolError: throw`, a failed approval ask, a
 * cancellation, a durable suspension.
 */
export function runToolCalls<R, E = never>(
  calls: readonly ToolCall[],
  limit: number,
  ctx: InvokeContext | undefined,
  dispatch: (
    call: ToolCall,
    ctx: InvokeContext | undefined,
    report: (event: E) => void,
  ) => Promise<R>,
  reports = false,
): AsyncGenerator<BoundedStep<R, E>> {
  return runBounded(calls, limit, ctx, REASONS, dispatch, reports);
}
