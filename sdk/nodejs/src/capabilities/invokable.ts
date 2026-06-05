import type { InvokeContext } from "../cancellation.js";

export interface Invocable<TInput = Record<string, any>, TOutput = any> {
  /**
   * @param inputs  Caller-supplied invocation inputs.
   * @param ctx  Out-of-band per-invoke context carrying the cancellation token.
   *   Optional — controllers that ignore it keep working unchanged. The kernel
   *   always supplies it; a never-cancellable sentinel is passed when no source
   *   was seeded for the invocation tree.
   */
  invoke(inputs: TInput, ctx?: InvokeContext): Promise<TOutput>;
}
