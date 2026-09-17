import type { ResourceContext, ResourceInstance, ResourceManifest } from "@telorun/sdk";
import type { ModuleContext } from "../../module-context.js";

/**
 * `Telo.Function` — a function written in CEL.
 *
 * A kernel built-in for the reason `Telo.JsonSchema` is: a module must be able to
 * declare a function without importing something to do it. Its instance is one
 * synchronous `call(args)` evaluating the body over the arguments, keyed by
 * parameter name, in the module that declared it — the module whose dispatch
 * table carries the calls the body makes.
 *
 * It implements no lifecycle verb and publishes no reading, so
 * `resources.<name>` reads as absent: a function is reached through a module
 * name, never through the resource scope. A body is statically typed from its
 * signature and not validated here.
 */
export async function create(
  resource: ResourceManifest,
  ctx: ResourceContext,
): Promise<ResourceInstance> {
  const module = ctx.moduleContext as unknown as ModuleContext;
  const body = (resource as { body?: unknown }).body;
  const instance = {
    call: (args: Record<string, unknown>) => module.evaluateFunctionBody(body, args),
  };
  return instance as unknown as ResourceInstance;
}
