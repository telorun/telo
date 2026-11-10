import type { ResourceContext, ResourceInstance, ResourceManifest } from "@telorun/sdk";

/**
 * `Telo.Value` — a value shaped from its inputs by CEL.
 *
 * A kernel built-in for the reason `Telo.Sequence` is: the standalone value
 * shaper must not need an import. It binds and expands through the same SDK
 * seam `Run.Value`'s controller uses, so the two cannot answer differently.
 */
interface ValueManifest extends ResourceManifest {
  bindings?: Record<string, unknown>;
  value: unknown;
}

export async function create(
  resource: ResourceManifest,
  ctx: ResourceContext,
): Promise<ResourceInstance> {
  const { bindings, value } = resource as ValueManifest;
  const instance = {
    async invoke(inputs: Record<string, unknown>): Promise<unknown> {
      const scope = ctx.bindScope(bindings, { inputs: inputs ?? {} });
      return ctx.expandValue(value, scope);
    },
  };
  return instance as unknown as ResourceInstance;
}
