/**
 * The CRUD module's controllers: the model holding a collection's four shapes,
 * the reader behind the list and read-one routes, and the creator and updater
 * behind the two write routes. The delete route is a template and needs none.
 *
 * One namespace per kind; the kind's `controllers:` candidate selects it by
 * PURL fragment.
 */
export * as CreatorController from "./creator-controller.js";
export * as ModelController from "./model-controller.js";
export * as ReaderController from "./reader-controller.js";
export * as UpdaterController from "./updater-controller.js";
