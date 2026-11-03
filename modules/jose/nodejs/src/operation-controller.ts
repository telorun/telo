import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";

export interface Named {
  metadata: { name: string };
}

/**
 * The two exports every invocable of this bundle carries. `prepare` runs once at
 * creation, so configuration is read and refused before the first call.
 */
export function operationController<Config extends Named, Inputs, Outputs>(
  kind: string,
  prepare: (
    config: Config,
    ctx: ResourceContext,
    describe: string,
  ) => (inputs: Inputs, invokeCtx?: InvokeContext) => Promise<Outputs>,
) {
  return {
    register(): void {},
    async create(resource: Config, ctx: ResourceContext): Promise<ResourceInstance> {
      const run = prepare(resource, ctx, `${kind} "${resource.metadata.name}"`);
      return {
        invoke(inputs: Record<string, any>, invokeCtx?: InvokeContext) {
          return run(inputs as Inputs, invokeCtx);
        },
        snapshot() {
          return {};
        },
      };
    },
  };
}
