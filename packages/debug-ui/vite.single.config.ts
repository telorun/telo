import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Builds the standalone debug-watcher as a single self-contained `index.html`
// (JS + CSS inlined) to `app-single/`. This is the artifact the Telo CLI fetches
// on demand (hosted on npm, served via jsDelivr) and serves same-origin — one
// file means no archive unpacking on the CLI side. The multi-file `app-dist/`
// build (vite.config.ts) is kept separately.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "app-single",
    emptyOutDir: true,
  },
});
