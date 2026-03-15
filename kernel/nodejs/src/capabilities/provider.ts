import { createCapability } from "@telorun/sdk";

export const provider = createCapability({
  name: "provider",
  expand: {
    compile: ["**"],
  },
});
