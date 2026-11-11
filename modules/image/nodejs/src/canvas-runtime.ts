import type { ResourceContext } from "@telorun/sdk";
import { fileURLToPath } from "node:url";

/**
 * The canvas API, with its Skia addon located first.
 *
 * `@napi-rs/canvas` looks for its per-platform binary beside its own
 * `__filename`, which a bundle does not have, so the module ships the addon as a
 * `native:` file and names it in `NAPI_RS_NATIVE_LIBRARY_PATH` — the wrapper's
 * only override, read while it initializes. Single-flight, and resolved on the
 * first invocation rather than at `create()`: resolving a native file can stage
 * a download. A failed attempt is forgotten, so the next call tries again.
 */
let canvasModule: Promise<typeof import("@napi-rs/canvas")> | undefined;

export function loadCanvas(ctx: ResourceContext): Promise<typeof import("@napi-rs/canvas")> {
  canvasModule ??= (async () => {
    const addon = fileURLToPath(await ctx.resolveNativeFile("canvas"));
    // Skia reads ICU data from beside the addon on Windows; without it text layout aborts.
    if (process.platform === "win32") await ctx.resolveNativeFile("canvas-icu");
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = addon;
    return import("@napi-rs/canvas");
  })().catch((err: unknown) => {
    canvasModule = undefined;
    throw err;
  });
  return canvasModule;
}
