#!/usr/bin/env node
// Builds `dist/language-server.mjs`: the engine and everything it runs on
// (analyzer, ide-support, templating, sdk, editor-protocol,
// vscode-languageserver, ajv, yaml, cel-js, …) inlined into one ES module with
// no imports — the one artifact form every editor host ships and loads.
//
// Three refusals, all fatal: a bundle that still reaches outside itself (see
// `bundle-guard.mjs`); a `teloInlines` list in package.json that is not exactly
// the workspace packages the bundle holds (the changeset gate relies on it to
// demand a release here when one of them changes); and a `teloEditorProtocol`
// that is not the generation `@telorun/editor-protocol` defines — a host selects
// engines by that field, so a stale one advertises a protocol the engine does
// not speak.

import { build } from "esbuild";
import { readFileSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyInlines } from "../../../scripts/check-changeset-status.mjs";
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

/** Bundle the engine to `outfile` and refuse it unless it is self-contained and
 *  holds exactly the workspace packages `teloInlines` declares. */
export async function bundleEngine(outfile) {
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
  });
  const inlines = verifyInlines(PACKAGE, metafile);
  if (inlines.length > 0) {
    rmSync(outfile, { force: true });
    throw new Error(`teloInlines disagrees with the bundle:\n  ${inlines.join("\n  ")}`);
  }
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
    await bundleEngine(join(PACKAGE, "dist", "language-server.mjs"));
    console.log("language-server: built dist/language-server.mjs");
  } catch (error) {
    console.error(`language-server: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
