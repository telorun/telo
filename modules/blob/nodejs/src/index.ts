// For a backend: the store contract the operations call, and the guard they
// recognise a store by. Importing either is optional — a store is recognised by
// its methods, so a backend that imports nothing from here is still a store.
export type {
  BlobAbsent,
  BlobContent,
  BlobFound,
  BlobPutOptions,
  BlobStore,
} from "./blob-store-contract.js";
export { isBlobStore } from "./blob-store-contract.js";

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as Put from "./put-controller.js";
export * as Get from "./get-controller.js";
export * as Head from "./head-controller.js";
export * as Delete from "./delete-controller.js";
