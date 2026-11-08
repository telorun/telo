// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope. The bundle is also the load generator threads'
// entry, so nothing here may load a runtime value of `@telorun/sdk` at the top.
export * as Suite from "./suite.js";
export * as Comparison from "./comparison.js";
