import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";
import { bundledEnginePlugin } from "./vite-bundled-engine";

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: ["babel-plugin-react-compiler"],
      },
    }),
    bundledEnginePlugin(),
  ],
  resolve: {
    alias: {
      "@/": path.resolve(__dirname, "./src") + "/",
      // Resolve debug-ui from source so Vite processes its TSX + CSS imports
      // (its tsc `dist` build doesn't copy the stylesheet). More specific entry
      // first — alias matching is prefix-based and order-sensitive.
      "@telorun/debug-ui/components": path.resolve(
        __dirname,
        "../../packages/debug-ui/src/components/index.ts",
      ),
      "@telorun/debug-ui": path.resolve(__dirname, "../../packages/debug-ui/src/index.ts"),
      // Likewise the analyzer, whose `exports` would otherwise resolve to its
      // tsc `dist`. Nothing rebuilds that — there is no watcher and no root dev
      // script — so an edit to the manifest projection was invisible here until
      // someone remembered `pnpm --filter @telorun/analyzer build`, and the
      // failure mode is a stale picture with no error anywhere. Safe from
      // source for the reason debug-ui is: the analyzer is browser-safe by
      // contract, importing no Node built-ins. Templating and ide-support are
      // browser-safe by the same contract and went stale the same way.
      "@telorun/analyzer": path.resolve(__dirname, "../../analyzer/nodejs/src/index.ts"),
      "@telorun/templating": path.resolve(__dirname, "../../templating/nodejs/src/index.ts"),
      "@telorun/ide-support": path.resolve(__dirname, "../../packages/ide-support/src/index.ts"),
      "@telorun/language-host": path.resolve(__dirname, "../../packages/language-host/src/index.ts"),
      "@telorun/editor-protocol": path.resolve(__dirname, "../../packages/editor-protocol/src/index.ts"),
      "fs/promises": path.resolve(__dirname, "./src/empty.ts"),
      fs: path.resolve(__dirname, "./src/empty.ts"),
      path: path.resolve(__dirname, "./src/empty.ts"),
    },
  },
  server: {
    host: true,
  },
  build: {
    outDir: "dist",
  },
});
