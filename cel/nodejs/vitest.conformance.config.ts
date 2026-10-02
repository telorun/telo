import { defineConfig } from "vitest/config";

/**
 * The conformance replay, run only when a caller supplies the vectors directory
 * (`CEL_CONFORMANCE_DIR`). Separate from the package's own suite so that suite
 * depends on nothing outside this package.
 */
export default defineConfig({
  test: { include: ["conformance/**/*.test.ts"] },
});
