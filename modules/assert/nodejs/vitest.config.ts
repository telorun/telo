import { defineConfig } from "vitest/config";

// Workspace siblings resolve through their `source` export condition, as the
// kernel's bundle builder resolves them, so no sibling must be built first.
// `tsconfigRaw` stops esbuild reading `tsconfig.spec.json`, whose `extends`
// names no file.
export default defineConfig({
  resolve: { conditions: ["source"] },
  esbuild: { tsconfigRaw: "{}" },
});
