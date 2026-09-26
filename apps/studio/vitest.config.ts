import react from "@vitejs/plugin-react";
import path from "path";
import type { PluginOption } from "vite";
import { defineConfig } from "vitest/config";
import { bundledEnginePlugin } from "./vite-bundled-engine";

// `vitest/config` ships vite 5 types but the project pins vite 6, so the
// plugin signature mismatch is purely a type-import collision — the runtime
// shape is identical. Cast through the consumer-side PluginOption to satisfy
// the older signature without losing type checking on the rest of the config.
const reactPlugin = react({
  babel: { plugins: ["babel-plugin-react-compiler"] },
}) as unknown as PluginOption;

export default defineConfig({
  plugins: [reactPlugin, bundledEnginePlugin() as unknown as PluginOption] as never,
  resolve: {
    alias: {
      "@/": path.resolve(__dirname, "./src") + "/",
      // Mirrors `vite.config.ts`. It must: a test that resolved the analyzer
      // differently from the app would pass against code the app never runs,
      // which is how a stale `dist` went unnoticed here for two weeks.
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
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
  },
});
