// The process entry, for development and production alike. It owns transport
// only: listening, `/health`, static assets and where the server build comes
// from. Everything a page says is the React Router app's.
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createRequestListener } from "@react-router/node";

const production = process.env.NODE_ENV === "production";
const root = import.meta.dirname;

/** The settings module throws a `SettingsError` naming the variable; that
 *  message is the whole story, so it is printed without a stack. */
function refuseStart(error) {
  console.error(error?.name === "SettingsError" ? `hub-web: ${error.message}` : error);
  process.exit(1);
}

async function loadProduction() {
  const build = await import(pathToFileURL(path.join(root, "build/server/index.js")).href);
  const { default: sirv } = await import("sirv");
  const assets = sirv(path.join(root, "build/client"), {
    extensions: [],
    setHeaders: (res) => res.setHeader("Cache-Control", "public, max-age=31536000, immutable"),
  });
  return {
    build,
    // A miss falls through to the app, whose catch-all answers 404.
    serveStatic: (req, res, next) => (req.url.startsWith("/assets/") ? assets(req, res, next) : next()),
  };
}

/** Vite in middleware mode, the server build loaded through it on every request
 *  so an edit applies without a restart. Imported here only, so the production
 *  image never resolves it. */
async function loadDevelopment() {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({ root, server: { middlewareMode: true }, appType: "custom" });
  const load = () => vite.ssrLoadModule("virtual:react-router/server-build");
  return {
    build: await load(),
    load,
    serveStatic: (req, res, next) => vite.middlewares(req, res, next),
  };
}

let loaded;
try {
  loaded = production ? await loadProduction() : await loadDevelopment();
} catch (error) {
  refuseStart(error);
}

const { settings } = loaded.build.entry.module;
const handle = createRequestListener({
  build: loaded.load ?? loaded.build,
  mode: production ? "production" : "development",
});

const server = createServer((req, res) => {
  if (req.url.split("?", 1)[0] === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("ok\n");
    return;
  }
  loaded.serveStatic(req, res, () => {
    // When a body errors after the headers are sent (a sitemap shard whose later
    // page failed), the adapter's listener rejects without ending or destroying
    // the response — left alone, an unhandled rejection that stops the process.
    // Destroying the socket tells this one client the response is incomplete;
    // ending it would pass a truncated body off as whole.
    Promise.resolve(handle(req, res)).catch((error) => {
      console.error(error);
      res.destroy(error);
    });
  });
});

server.listen(settings.port, () => {
  const { port } = server.address();
  console.log(`hub-web (${production ? "production" : "development"}) listening on port ${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  });
}
