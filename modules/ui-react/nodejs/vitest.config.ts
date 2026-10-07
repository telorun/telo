import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // What a component imports as the host module is this module's host entry.
    alias: { "@telorun/ui-react": fileURLToPath(new URL("./src/browser/host-entry.ts", import.meta.url)) },
  },
  test: { include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"] },
});
