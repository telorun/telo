// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as HttpClientController from "./http-client-controller.js";
export * as HttpRequestController from "./http-request-controller.js";
