import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

// `vite` alone serves the UI against a server started separately
// (PLAN_APPROVAL_SERVER, default http://localhost:8080). The server refuses a
// foreign Origin, so the dev proxy forwards requests as same-origin ones.
const server = process.env.PLAN_APPROVAL_SERVER ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@/": path.resolve(__dirname, "./src") + "/",
    },
  },
  server: {
    proxy: {
      "/api": {
        target: server,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (request) => request.removeHeader("origin"));
        },
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
