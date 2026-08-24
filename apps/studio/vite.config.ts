import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: ["babel-plugin-react-compiler"],
      },
    }),
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
