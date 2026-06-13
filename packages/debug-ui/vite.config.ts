import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the standalone debug-watcher single-page app to `app-dist/`. A Telo
// runtime's debug server serves these static bytes at `/`; the editor instead
// imports the React components from `@telorun/debug-ui/components`. `base: "./"`
// keeps asset URLs relative so the bundle works whatever path the server mounts.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "app-dist",
    emptyOutDir: true,
  },
});
