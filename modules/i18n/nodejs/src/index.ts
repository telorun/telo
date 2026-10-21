// The reader of a translator's catalog set — what a dependent module's
// controller imports as `@telorun/i18n`.
export { catalogSetOf, type CatalogSet } from "./catalog-set.js";

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle.
export * as Catalog from "./catalog-controller.js";
export { Translator } from "./translator-controller.js";
export { Negotiator } from "./negotiator-controller.js";
