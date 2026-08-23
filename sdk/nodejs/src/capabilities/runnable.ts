import type { InvokeContext } from "../cancellation.js";
import type { EffectChain } from "../effect.js";

export interface Runnable {
  /**
   * Perform the resource's work, RETURNING the effects it leaves behind.
   *
   * A one-shot task that allocates nothing returns nothing. A service returns
   * the chain that opened its socket and took its kernel hold, and the runtime
   * unwinds it — at teardown, or immediately if a later step of the same `run()`
   * fails. There is no `teardown()` to keep in step with it.
   *
   * @param ctx  Out-of-band per-run context carrying the cancellation token.
   *   Optional — runnables that ignore it keep working unchanged. Long-lived
   *   targets (servers, loops) observe `ctx.cancellation` to stop early when the
   *   boot run is cancelled (e.g. SIGINT).
   */
  run(ctx?: InvokeContext): Promise<EffectChain<unknown> | void> | EffectChain<unknown> | void;
}
