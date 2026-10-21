/**
 * The UI vocabulary's controllers: each composite kind turns its configuration
 * into the node a renderer draws. No code here runs in a browser.
 *
 * One namespace per kind; each kind's `controllers:` candidate selects one by
 * PURL fragment, so the whole module is one bundle.
 */
// The surface a dependent module's controller reaches through `@telorun/ui`:
// how a built browser entry becomes the files a page loads, so a renderer
// addresses its own entries exactly as a component's are addressed.
export { entryAssets, type AssetRef } from "./browser-entry-assets.js";
export type { AssetFile } from "./composite.js";
// What presents the values a page's own `value` and `list` nodes name, and
// what a composite's placement contributes to the node it provided — so a
// renderer's page tree reads exactly as a composite's does.
export { placed, presented, type AuthoredNode, type RootShapes } from "./node-resolution.js";
export { modelShape, type Shape, type ShapeReader } from "./model-schema.js";
export { placedRowAction } from "./row-actions.js";
// How a renderer's controller sends the texts of what `ui` provides: each text
// of a `Ui.SpecNode` found by following its schema and translated, and the
// renderer's own words.
export { SpecTranslator, type SpecSchemas } from "./spec-translation.js";
export { isWords, type Words } from "./words-controller.js";

export * as WordsController from "./words-controller.js";
export * as ViewController from "./view-controller.js";
export * as DataController from "./data-controller.js";
export * as TableController from "./table-controller.js";
export * as FormController from "./form-controller.js";
export * as ActionController from "./action-controller.js";
export * as FiltersController from "./filters-controller.js";
export * as CollectionController from "./collection-controller.js";
export * as ComponentController from "./component-controller.js";
export * as ComponentExportController from "./component-export-controller.js";
export * as ThemeController from "./theme-controller.js";
export * as CollectionOptionsController from "./option-source.js";
export {
  ChoiceFieldController,
  DateRangeFieldController,
  InputFieldController,
  PickerFieldController,
} from "./field-controllers.js";
export {
  DialogController,
  DrawerController,
  InlineSurfaceController,
  PageSurfaceController,
  PanelController,
  PopoverController,
} from "./surface-controllers.js";
export {
  AbovePlacementController,
  AsidePlacementController,
  CollapsiblePlacementController,
  OverlayPlacementController,
} from "./filter-placement.js";
export { LocalStoreController, SessionStoreController } from "./state-store.js";
