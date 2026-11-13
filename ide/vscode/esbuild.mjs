import esbuild from "esbuild";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const watch = process.argv.includes("--watch");
// The release staging (`scripts/stage-vsix.mjs`) puts the published engine there itself.
const withEngine = !process.argv.includes("--no-engine");

// A development build bundles @telorun/language-server's built file as is; the
// engine a release ships is the published build, staged by `scripts/stage-vsix.mjs`.
if (withEngine) {
  const require = createRequire(import.meta.url);
  const engineDir = dirname(require.resolve("@telorun/language-server/package.json"));
  mkdirSync("dist/engine", { recursive: true });
  copyFileSync(join(engineDir, "dist", "language-server.mjs"), "dist/engine/language-server.mjs");
}

// The file icon is the repo's one Telo mark, staged rather than copied by hand.
copyFileSync("../../assets/telo.svg", "dist/file-icon.svg");

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
  metafile: true,
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  const { metafile } = await esbuild.build(options);
  writeFileSync("dist/extension.meta.json", JSON.stringify(metafile, null, 2) + "\n");
}
