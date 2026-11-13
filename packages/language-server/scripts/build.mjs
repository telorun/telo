#!/usr/bin/env node
// Builds `dist/language-server.mjs`: the engine and everything it runs on
// (analyzer, ide-support, templating, sdk, editor-protocol,
// vscode-languageserver, ajv, yaml, cel-js, …) inlined into one ES module with
// no imports — the one artifact form every editor host ships and loads.
//
// Two refusals, both fatal: a bundle that still reaches outside itself (see
// `bundle-guard.mjs`), and a `teloEditorProtocol` that is not the generation
// `@telorun/editor-protocol` defines — a host selects engines by that field, so
// a stale one advertises a protocol the engine does not speak.
//
// Beside the bundle it writes esbuild's metafile, `dist/language-server.meta.json`,
// which the release planner reads as this unit's inline edges: every workspace
// package whose files the bundle holds.
//
// `--published` (the `prepack`) builds the engine that ships: the version modules
// it inlines — its own, the analyzer's and cel's — are substituted at bundle time
// with their published sources (`generate-telo-version.mjs`'s `versionModules`),
// so the bundle embeds exactly the line's version and no other package's source
// tree is written.

import { build } from "esbuild";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VERSION_MODULES, versionModules } from "../../../scripts/generate-telo-version.mjs";
import { bundleEscapes } from "./bundle-guard.mjs";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `package.json`'s `teloEditorProtocol` against the contract's constant. */
export async function checkProtocolGeneration() {
  const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8"));
  const { TELO_EDITOR_PROTOCOL } = await import("@telorun/editor-protocol");
  if (manifest.teloEditorProtocol !== TELO_EDITOR_PROTOCOL) {
    throw new Error(
      `package.json declares teloEditorProtocol ${JSON.stringify(manifest.teloEditorProtocol)}, ` +
        `but @telorun/editor-protocol defines generation ${TELO_EDITOR_PROTOCOL}. Hosts pick an ` +
        `engine by this field — set it to the generation the engine speaks.`,
    );
  }
}

/** An esbuild plugin answering each inlined version module with its published source. */
function publishedVersionModules() {
  const sources = versionModules({ published: true });
  const byPath = new Map(
    ["analyzer", "cel", "languageServer"].map((key) => [join(VERSION_MODULES[key].pkg, VERSION_MODULES[key].file), sources[key]]),
  );
  return {
    name: "published-version-modules",
    setup(context) {
      context.onLoad({ filter: /(telo-version|engine-version)\.ts$/ }, (args) =>
        byPath.has(args.path) ? { contents: byPath.get(args.path), loader: "ts" } : undefined,
      );
    },
  };
}

/** Bundle the engine to `outfile`, with its metafile beside it, and refuse it
 *  unless it is self-contained. */
export async function bundleEngine(outfile, { published = false } = {}) {
  const { metafile } = await build({
    entryPoints: [join(PACKAGE, "src", "index.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    // Workspace siblings are bundled from their sources, so the artifact is
    // never built against a stale `dist`.
    conditions: ["source"],
    // Left in the output rather than failing resolution, so the guard below
    // names every one of them with its position.
    external: ["node:*", ...builtinModules],
    logLevel: "warning",
    metafile: true,
    absWorkingDir: PACKAGE,
    plugins: published ? [publishedVersionModules()] : [],
  });
  writeFileSync(outfile.replace(/\.mjs$/, ".meta.json"), JSON.stringify(metafile, null, 2) + "\n");
  const escapes = bundleEscapes(readFileSync(outfile, "utf8"));
  if (escapes.length > 0) {
    rmSync(outfile, { force: true });
    throw new Error(
      `the engine bundle is not self-contained — a host loads it as one module with nothing ` +
        `beside it, so each of these must go (bundle positions):\n  ${escapes.join("\n  ")}`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await checkProtocolGeneration();
    await bundleEngine(join(PACKAGE, "dist", "language-server.mjs"), { published: process.argv.includes("--published") });
    console.log("language-server: built dist/language-server.mjs");
  } catch (error) {
    console.error(`language-server: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
