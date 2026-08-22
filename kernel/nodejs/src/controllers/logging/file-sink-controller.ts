import { TEARDOWN_LAST, type ResourceInstance } from "@telorun/sdk";
import type { BuiltinControllerContext } from "../../internal-context.js";
import { FileSink } from "../../logging/file-sink.js";
import { bufferPolicyFor, sinkIdFor } from "./sink-identity.js";

/**
 * Controller for the `Telo.FileSink` kernel built-in (§10.2). Dependency-free —
 * a path is all it needs — so it joins the console sink in the eager tier.
 *
 * `on_full: block` is rejected at construction with an actionable diagnostic
 * naming the sink; see `sink-identity.ts` for why degrading is the wrong call.
 */
export async function create(
  resource: any,
  ctx: BuiltinControllerContext,
): Promise<ResourceInstance> {
  const sinkId = sinkIdFor(resource);
  const policy = bufferPolicyFor(resource);

  const sink = new FileSink({
    sinkId,
    level: ctx.logging.levelFor(resource.level),
    destination: resource.destination,
    encoding: resource.encoding,
    policy,
    onDrop: () => ctx.logging.recordDrop(sinkId, "buffer_full"),
  });

  // Attach and its inverse as one pair, performed here rather than returned from
  // `init()`: a sink must receive records from construction on, or everything
  // logged while the rest of the graph initializes reaches no destination. The
  // flush is what makes a clean shutdown lose nothing that was buffered.
  await ctx
    .effect("log sink", async () => {
      ctx.logging.attach(sink);
      return {
        result: sink,
        inverse: async () => {
          await sink.flush();
          ctx.logging.detach(sink);
          await sink.close();
        },
      };
    })
    .perform();

  return {
    sink,
    teardownPriority: TEARDOWN_LAST,
  } as unknown as ResourceInstance;
}
