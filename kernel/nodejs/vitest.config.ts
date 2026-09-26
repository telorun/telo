import { defineConfig } from "vitest/config";

/**
 * The default run must pass on a clean checkout with nothing installed — the
 * same rule `test-suite.yaml` follows, so a red kernel suite means the code is
 * wrong rather than that Docker was not up. `tests/integration/` holds the tests
 * that need infrastructure (a Docker daemon, images built from the workspace),
 * and they run from `test:integration`.
 *
 * Workspace siblings resolve through their `source` export condition, matching
 * `tsconfig.json`'s `customConditions`, rather than through a `dist` nothing rebuilds.
 */
export default defineConfig({
  resolve: { conditions: ["source"] },
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "tests/integration/**"],
  },
});
