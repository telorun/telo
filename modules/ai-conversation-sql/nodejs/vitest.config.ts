import { defineConfig } from "vitest/config";

// Workspace siblings resolve through their `source` export condition, as the
// kernel's bundle builder resolves them, so no sibling must be built first.
export default defineConfig({
  resolve: { conditions: ["source"] },
  // SQLite racing tests run beside every other package's on a Windows runner.
  test: { testTimeout: 30_000 },
});
