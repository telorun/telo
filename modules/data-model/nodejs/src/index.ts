/**
 * The data-model module's controller, and the guards a kind extending
 * `DataModel.Collection` runs beside its own. The code specifier
 * `@telorun/data-model` is this entry point.
 */
export * as CollectionController from "./collection-controller.js";
export { collectionProblems, type CollectionProblem } from "./collection-problems.js";
export { readCollection, type CollectionDeclaration } from "./collection-declaration.js";
export type { AcceptedQuery, JsonSchema, RelationTarget } from "./collection-types.js";
