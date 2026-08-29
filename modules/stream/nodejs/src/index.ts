/**
 * Generic stream substrate: the ends of a pipeline (`Stream.Of`,
 * `Stream.Collect`), byte re-framing (`Stream.Chunk`), and the three
 * element-wise transforms every streaming protocol is assembled from
 * (`Stream.Map`, `Stream.Scan`, `Stream.FlatMap`).
 */

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as ChunkController from "./chunk-controller.js";
export * as CollectController from "./collect-controller.js";
export * as FlatMapController from "./flat-map-controller.js";
export * as MapController from "./map-controller.js";
export * as OfController from "./of-controller.js";
export * as ScanController from "./scan-controller.js";
