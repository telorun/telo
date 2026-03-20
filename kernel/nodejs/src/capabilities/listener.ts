import type { ResourceDefinition } from "@telorun/sdk";

export const service: ResourceDefinition = {
  kind: "Kernel.Abstract",
  metadata: { name: "Service", module: "Kernel" },
};
