import type { ResourceContext } from "@telorun/sdk";

/**
 * Context interface used by built-in kernel controllers (Telo.Application /
 * Telo.Library / Telo.Import / Telo.Definition / Telo.Abstract) that need
 * privileged access to load-time graph identity. These methods are
 * intentionally *not* on the public `ResourceContext` exposed to module
 * authors — they couple the caller to the kernel's load-time view of the
 * world, and the import-controller is the only consumer today.
 *
 * `ResourceContextImpl` in this package implements both interfaces, so a
 * controller authored against this type still works under the generic
 * `controller.create(resource, ctx)` dispatch — the kernel just types it
 * locally as `BuiltinControllerContext` instead of `ResourceContext`.
 */
export interface BuiltinControllerContext extends ResourceContext {
  /** True when `url` resolved (via the loader's URL → canonical-source
   *  map) to a module that was part of the entry graph successfully
   *  analyzed during `Kernel.load()`. */
  isImportValidatedAtLoad(url: string): boolean;
  /** Resolve `importSource` against `fromSource` through the loader's
   *  source-chain `resolveRelative`. Identical to what `loadGraph` used
   *  internally — so the produced URL agrees with the loader's caches. */
  resolveImportUrl(fromSource: string, importSource: string): string;
}
