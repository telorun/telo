import { defineConfig } from "vitest/config";

/** Workspace siblings resolve through their `source` export condition, as in `tsconfig.json`. */
export default defineConfig({
  resolve: { conditions: ["source"] },
  test: { include: ["tests/**/*.test.ts"] },
});
