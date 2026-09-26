import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

/** The module the app imports the bundled engine's file name from. */
const MODULE_ID = "virtual:telo-bundled-engine";
const RESOLVED_ID = `\0${MODULE_ID}`;

/**
 * Ships `@telorun/language-server`'s built `dist/language-server.mjs` — the
 * same file every other telo version is downloaded as, never compiled from
 * source here — as a static asset named by its content,
 * `engine/language-server-<sha256 prefix>.mjs`, and tells the app that name
 * through `virtual:telo-bundled-engine`. Nothing stamps a version: the engine
 * names itself in its handshake. The dev server serves the same file at the
 * same path.
 */
export function bundledEnginePlugin(): Plugin {
  const engineDir = dirname(createRequire(import.meta.url).resolve("@telorun/language-server/package.json"));
  const engineFile = join(engineDir, "dist", "language-server.mjs");
  const engine = () => {
    if (!existsSync(engineFile)) {
      throw new Error(
        `studio bundles the telo engine from ${engineFile}, which is not built: run pnpm --filter "@telorun/language-server..." build.`,
      );
    }
    const source = readFileSync(engineFile);
    return { source, fileName: `engine/language-server-${createHash("sha256").update(source).digest("hex").slice(0, 16)}.mjs` };
  };
  return {
    name: "telo-bundled-engine",
    resolveId: (id) => (id === MODULE_ID ? RESOLVED_ID : undefined),
    load: (id) => (id === RESOLVED_ID ? `export default ${JSON.stringify(engine().fileName)};` : undefined),
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const current = engine();
        if (request.url?.split("?")[0] !== `/${current.fileName}`) return next();
        response.setHeader("content-type", "text/javascript");
        response.end(current.source);
      });
    },
    generateBundle() {
      const { source, fileName } = engine();
      this.emitFile({ type: "asset", fileName, source });
    },
  };
}
