import react from "@vitejs/plugin-react";
import path from "path";
import type { PluginOption } from "vite";
import { defineConfig } from "vitest/config";

// `vitest/config` ships vite 5 types but the project pins vite 6, so the
// plugin signature mismatch is purely a type-import collision — the runtime
// shape is identical. Cast through the consumer-side PluginOption to satisfy
// the older signature without losing type checking on the rest of the config.
const reactPlugin = react({
  babel: { plugins: ["babel-plugin-react-compiler"] },
}) as unknown as PluginOption;

export default defineConfig({
  plugins: [reactPlugin] as never,
  resolve: {
    alias: {
      "@/": path.resolve(__dirname, "./src") + "/",
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
