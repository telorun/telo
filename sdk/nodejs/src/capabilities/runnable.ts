import type { InvokeContext } from "../cancellation.js";

export interface Runnable {
  /**
   * @param ctx  Out-of-band per-run context carrying the cancellation token.
   *   Optional — runnables that ignore it keep working unchanged. Long-lived
   *   targets (servers, loops) observe `ctx.cancellation` to stop early when the
   *   boot run is cancelled (e.g. SIGINT).
   */
  run(ctx?: InvokeContext): Promise<void>;
}
