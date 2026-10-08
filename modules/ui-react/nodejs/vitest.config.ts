import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // What a component imports as the host module is this module's host entry.
    alias: { "@telorun/ui-react": fileURLToPath(new URL("./src/browser/host-entry.ts", import.meta.url)) },
  },
  // These tests draw whole pages in a simulated document, which a slow runner
  // takes several times longer over than a workstation does.
  test: { include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"], testTimeout: 30_000 },
});
