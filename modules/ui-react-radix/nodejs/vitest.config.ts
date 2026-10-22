import { defineConfig } from "vitest/config";

export default defineConfig({
  // Workspace siblings resolve through their `source` export condition, as the
  // kernel's bundle builder resolves them, so no sibling must be built first.
  resolve: { conditions: ["source"] },
  test: { include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"] },
});
