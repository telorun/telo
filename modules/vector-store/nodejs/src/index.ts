export type {
  VectorRecord,
  VectorMatch,
  QueryOptions,
  VectorStoreHandle,
  MetadataFilter,
  FieldCondition,
  FilterScalar,
} from "./store.js";
export { isVectorStore } from "./store.js";

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as Match from "./match.js";
export * as Record from "./record.js";
export * as Removal from "./removal.js";
