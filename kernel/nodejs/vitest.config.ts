import { defineConfig } from "vitest/config";

/**
 * The default run must pass on a clean checkout with nothing installed — the
 * same rule `test-suite.yaml` follows, so a red kernel suite means the code is
 * wrong rather than that Docker was not up. `tests/integration/` holds the tests
 * that need infrastructure (a Docker daemon, images built from the workspace),
 * and they run from `test:integration`.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "tests/integration/**"],
  },
});
