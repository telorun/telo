export { Mutex } from "./mutex.js";
export type { AcquireResult } from "./mutex.js";

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as CriticalController from "./critical-controller.js";
