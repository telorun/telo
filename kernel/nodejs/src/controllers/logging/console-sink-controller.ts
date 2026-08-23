import { TEARDOWN_LAST, type ResourceInstance } from "@telorun/sdk";
import type { BuiltinControllerContext } from "../../internal-context.js";
import { ConsoleSink } from "../../logging/console-sink.js";
import { sinkIdFor } from "./sink-identity.js";

/**
 * Controller for the `Telo.ConsoleSink` kernel built-in (§10.2).
 *
 * Dependency-free by construction — it needs nothing but a descriptor — which is
 * what qualifies it for eager instantiation before the init loop, so a runtime
 * never has zero destinations.
 *
 * The instance exposes the sink contract directly on itself rather than behind
 * `invoke()`: the logger writes to it through that contract, never through
 * dispatch (§12.1).
 */
export async function create(
  resource: any,
  ctx: BuiltinControllerContext,
): Promise<ResourceInstance> {
  const sink = new ConsoleSink({
    sinkId: sinkIdFor(resource),
    level: ctx.logging.levelFor(resource.level),
    destination: resource.destination,
    encoding: resource.encoding,
    color: resource.color,
    env: ctx.env,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
  });

  // Attaching is the effect, and detaching-and-closing is its inverse — as one
  // pair, performed HERE rather than returned from `init()`, because a sink must
  // be receiving records from the moment it is constructed: everything logged
  // while the rest of the graph creates and initializes would otherwise reach no
  // destination. Sinks are pinned to unwind after every other resource, so
  // anything logged during its own shutdown still reaches a live sink.
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
