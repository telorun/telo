/**
 * The CRUD module's controllers: the reader behind the list and read-one
 * routes, and the updater behind the replace route. The create and delete
 * routes are templates and need none.
 *
 * One namespace per kind; the kind's `controllers:` candidate selects it by
 * PURL fragment.
 */
export * as ReaderController from "./reader-controller.js";
export * as UpdaterController from "./updater-controller.js";
