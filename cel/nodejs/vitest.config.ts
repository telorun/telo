import { defineConfig } from "vitest/config";

/**
 * The package's own suite. The conformance replay is deliberately NOT here: it
 * needs a vectors directory handed to it, and this suite must pass with none.
 */
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
