/**
 * Collection — pure CEL-driven reshaping of a collection of records. Each
 * controller is exported from its own subpath (./group-by).
 */

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as ChunkController from "./chunk-controller.js";
export * as DistinctController from "./distinct-controller.js";
export * as FoldController from "./fold-controller.js";
export * as GroupByController from "./group-by-controller.js";
export * as JoinController from "./join-controller.js";
export * as SortController from "./sort-controller.js";
export * as SummarizeController from "./summarize-controller.js";
