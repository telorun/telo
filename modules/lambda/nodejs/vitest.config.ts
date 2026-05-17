import { defineConfig } from "vitest/config";

export default defineConfig({
  // The repo's tsconfig.base.json pins `target: es2024`, which esbuild
  // (vite's transformer) doesn't recognise and warns about per-file —
  // dozens of warnings that bury real test output in CI. Feed esbuild a
  // tsconfigRaw with a known target so it skips the file-system tsconfig
  // lookup entirely.
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        target: "es2022",
        useDefineForClassFields: true,
      },
    },
  },
  test: {
    // E2E tests spin up Docker containers via testcontainers — fixture-prep
    // (pnpm pack + install) plus container start can easily exceed default
    // hook/test timeouts on slow CI.
    hookTimeout: 5 * 60_000,
    testTimeout: 2 * 60_000,
  },
});
