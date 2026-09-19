import type { ResourceContext } from "@telorun/sdk";
import { fileURLToPath } from "node:url";

/**
 * Everything pdf.js and its canvas need that a bundle cannot resolve for
 * itself, resolved once per process.
 *
 * A controller bundle is one file in a cache directory. Two of its dependencies
 * do not survive that, and each is handled the way this repo already handles the
 * shape:
 *
 *  - **The Skia addon.** `@napi-rs/canvas` looks for its per-platform binary
 *    beside its own `__filename`, which a bundle does not have. The module ships
 *    the addon as a `native:` file instead and names its path in
 *    `NAPI_RS_NATIVE_LIBRARY_PATH`, the wrapper's own override — the same move
 *    `sqlite` makes with better-sqlite3's `nativeBinding`.
 *  - **pdf.js's fonts, CMaps and wasm decoders.** pdf.js resolves them beside
 *    its package; the module ships them as its own assets and tells pdf.js
 *    where they are, which is the supported way to relocate them.
 *
 * Both are resolved lazily, on the first invocation rather than at `create()`:
 * resolving a native file materializes a layer and can stage a download, which
 * is observable I/O and belongs nowhere near `init()`.
 *
 * Every path here is `ctx.resolveControllerFile`, never `ctx.resolveModuleFile`:
 * these files ship with THIS module, and the resource's author is someone else's
 * manifest — resolving against them found the assets beside the test that
 * declared the resource.
 */

/** pdf.js's asset locations, as filesystem paths with the trailing separator its
 *  option contract expects. Its Node fetcher reads them with `fs.readFile`,
 *  which takes a path rather than a `file://` string. */
export interface PdfAssetOptions {
  standardFontDataUrl: string;
  cMapUrl: string;
  cMapPacked: true;
  wasmUrl: string;
}

let assetOptions: Promise<PdfAssetOptions> | undefined;
let canvasModule: Promise<typeof import("@napi-rs/canvas")> | undefined;

/**
 * The canvas API, with its addon located first.
 *
 * Single-flight and cached: the wrapper reads the environment variable while it
 * initializes, so the assignment has to happen before the first import and must
 * not be racing a second one. It is set for the whole process — the variable is
 * the wrapper's only override — so it is written once and left, rather than
 * being restored under a concurrent load that would then look elsewhere.
 */
export function loadCanvas(ctx: ResourceContext): Promise<typeof import("@napi-rs/canvas")> {
  canvasModule ??= (async () => {
    const addon = fileURLToPath(await ctx.resolveNativeFile("canvas"));
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = addon;
    return import("@napi-rs/canvas");
  })();
  return canvasModule;
}

/** Where this module's copy of pdf.js's assets lives. */
export function pdfAssetOptions(ctx: ResourceContext): Promise<PdfAssetOptions> {
  assetOptions ??= (async () => {
    const root = fileURLToPath(await ctx.resolveControllerFile("./assets/pdfjs/"));
    const dir = (name: string) => `${root.replace(/[/\\]$/, "")}/${name}/`;
    return {
      standardFontDataUrl: dir("standard_fonts"),
      cMapUrl: dir("cmaps"),
      cMapPacked: true,
      wasmUrl: dir("wasm"),
    };
  })();
  return assetOptions;
}

/**
 * pdf.js, with the browser globals it polyfills from canvas already in place.
 *
 * pdf.js reaches for `@napi-rs/canvas` itself, through a `require` resolved from
 * whatever file it was loaded from — the bundle, where the package is not
 * resolvable. Every use of that require is a fallback for something it can be
 * given instead: the `DOMMatrix` / `ImageData` / `Path2D` globals, set here from
 * the canvas this module loaded, and the canvas each render draws on, which the
 * controllers pass explicitly. Setting the globals BEFORE the import is what
 * makes the difference, since pdf.js only installs its own when they are absent.
 */
let pdfjs: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | undefined;
export function loadPdfjs(
  ctx: ResourceContext,
): Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> {
  pdfjs ??= (async () => {
    const canvas = await loadCanvas(ctx);
    const globals = globalThis as Record<string, unknown>;
    globals.DOMMatrix ??= canvas.DOMMatrix;
    globals.ImageData ??= canvas.ImageData;
    globals.Path2D ??= canvas.Path2D;
    const module = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // pdf.js parses in a worker, and its Node fallback loads one by importing
    // `pdf.worker.mjs` beside its own build — beside the bundle, here, where it
    // is not. The module ships the worker as an asset and names it, which is
    // what `workerSrc` is for.
    module.GlobalWorkerOptions.workerSrc = await ctx.resolveControllerFile(
      "./assets/pdfjs/pdf.worker.mjs",
    );
    return module;
  })();
  return pdfjs;
}
