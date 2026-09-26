import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const watch = process.argv.includes("--watch");

// The bundled engine is @telorun/language-server's built file, shipped as is —
// the same artifact every other telo version is downloaded as, never compiled
// from source here. Its version is what its own handshake reports, so nothing
// here stamps one.
const require = createRequire(import.meta.url);
const engineDir = dirname(require.resolve("@telorun/language-server/package.json"));
mkdirSync("dist/engine", { recursive: true });
copyFileSync(join(engineDir, "dist", "language-server.mjs"), "dist/engine/language-server.mjs");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
