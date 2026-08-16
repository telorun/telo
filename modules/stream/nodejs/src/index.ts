/**
 * Generic stream substrate. `Stream.Of` emits a declared list of literal items
 * as a `Stream`, value-agnostic.
 */

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as ChunkController from "./chunk-controller.js";
export * as CollectController from "./collect-controller.js";
export * as OfController from "./of-controller.js";
