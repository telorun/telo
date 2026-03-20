import type { ResourceDefinition } from "@telorun/sdk";

export const mount: ResourceDefinition = {
  kind: "Kernel.Abstract",
  metadata: { name: "Mount", module: "Kernel" },
};
