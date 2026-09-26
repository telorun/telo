import { defineConfig } from "vitest/config";

/**
 * Workspace siblings resolve through their `source` export condition, so the
 * in-process answers a test compares the engine against come from the same
 * sources the bundle is built from.
 */
export default defineConfig({
  resolve: { conditions: ["source"] },
  test: {
    globalSetup: ["./tests/global-setup.ts"],
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
