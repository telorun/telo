// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle.
export * as Catalog from "./catalog-controller.js";
export { Translator } from "./translator-controller.js";
