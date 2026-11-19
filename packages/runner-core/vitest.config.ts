import { defineConfig } from "vitest/config";

export default defineConfig({
  // The SQLite session-store tests run beside every other package's on a Windows runner.
  test: { testTimeout: 30_000 },
});
