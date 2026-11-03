import type { ResourceInstance } from "@telorun/sdk";

/** The two exports every controller module of this bundle carries. */
export function operationController<Config, Inputs, Outputs>(
  run: (inputs: Inputs, config: Config) => Outputs | Promise<Outputs>,
) {
  return {
    register(): void {},
    async create(resource: Config): Promise<ResourceInstance> {
      return {
        async invoke(inputs: Record<string, any>) {
          return run(inputs as Inputs, resource);
        },
        snapshot() {
          return {};
        },
      };
    },
  };
}
