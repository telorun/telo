import type { ResourceDefinition } from "@telorun/sdk";

export const runnable: ResourceDefinition = {
  kind: "Kernel.Abstract",
  metadata: { name: "Runnable", module: "Kernel" },
};
