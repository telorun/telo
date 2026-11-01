/**
 * The CRUD module's controllers: the collection holding a table's record shapes
 * and declared query, the reader behind the list, facet and read-one requests,
 * and the creator and updater behind the two write routes. The delete route is
 * a template and needs none.
 *
 * One namespace per kind; the kind's `controllers:` candidate selects it by
 * PURL fragment.
 */
export * as CollectionController from "./collection-controller.js";
export * as CreatorController from "./creator-controller.js";
export * as ReaderController from "./reader-controller.js";
export * as UpdaterController from "./updater-controller.js";
