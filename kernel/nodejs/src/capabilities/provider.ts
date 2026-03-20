import type { ResourceDefinition } from "@telorun/sdk";

export const provider: ResourceDefinition = {
  kind: "Kernel.Abstract",
  metadata: { name: "Provider", module: "Kernel" },
  expand: {
    compile: ["**"],
  },
};
