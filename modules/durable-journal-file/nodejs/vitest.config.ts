import { defineConfig } from "vitest/config";

export default defineConfig({
  // Journal tests fsync every write, beside every other package's tests on a Windows runner.
  test: { testTimeout: 30_000 },
});
