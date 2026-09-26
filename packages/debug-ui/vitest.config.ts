import { defineConfig } from "vitest/config";

/**
 * Workspace siblings resolve through their `source` export condition, matching
 * `tsconfig.json`'s `customConditions`. Without it they resolve to a `dist` that
 * nothing rebuilds, and a test passes or fails against code the tree no longer holds.
 */
export default defineConfig({
  resolve: { conditions: ["source"] },
});
