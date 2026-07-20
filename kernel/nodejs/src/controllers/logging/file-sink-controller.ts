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

  ctx.logging.attach(sink);

  return {
    sink,
    teardownPriority: TEARDOWN_LAST,
    teardown: async () => {
      await sink.flush();
      ctx.logging.detach(sink);
      await sink.close();
    },
  } as unknown as ResourceInstance;
}
