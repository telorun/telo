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
// What presents the values a page's own `value` and `list` nodes name, what a
// composite's placement contributes to the node it provided, and which of a
// menu's items are delivered — so a renderer's page tree reads exactly as a
// composite's does.
export { deliveredMenu, placed, presented, type AuthoredNode, type RootShapes } from "./node-resolution.js";
export { modelShape, type Shape, type ShapeReader } from "./model-schema.js";
export { placedRowAction } from "./row-actions.js";
// What a listing layout of another module is called with and answers.
export type { LayoutAnswer, LayoutCollection, LayoutInputs, LayoutProblem } from "./listing-layout.js";
// The requests a layout's read plan sends, as `conformance/listing-reads.json` pins them.
export {
  pageRequest,
  reloadRequests,
  valuesRequest,
  type CollectionRequest,
  type ListingReads,
  type ReadPosition,
  type RelatedSource,
} from "./listing-requests.js";
// What a renderer's controller hosts a page with: the page it invokes per
// request, the nodes of its own header prepared and delivered the same way, the
// request headers they read, and the navigation with every default filled.
export { errorNode, RequestNodes, type EvaluatedNode } from "./delivered-nodes.js";
export { headerReads, unionReads, type HeaderReads } from "./request-header-reads.js";
export { isPage, type PageDocument, type PageInputs, type PageInstance, type PageReading, type PageRequest } from "./page-controller.js";
export { resolvedPageWidth, type PageWidth } from "./page-width.js";
export {
  deliveredNavigation,
  preparedNavigation,
  type IconAddress,
  type NavigationConfig,
  type NavigationEntrySpec,
  type NavigationPlacementSpec,
  type PreparedNavigation,
} from "./navigation.js";
export { isIcon, type IconFile } from "./icon.js";
// How a renderer's controller sends the texts of what `ui` provides: each text
// of a `Ui.SpecNode` found by following its schema and translated, and the
// renderer's own words.
export { SpecTranslator, type SpecSchemas } from "./spec-translation.js";
export { isWords, type Words } from "./words-controller.js";
// The closed design token names, for whatever reads a token set by name: a
// renderer spelling them in CSS, a check that a theme gives each a value.
export { DESIGN_TOKENS, type DesignTokenName } from "./design-tokens-controller.js";

export * as WordsController from "./words-controller.js";
export * as ViewController from "./view-controller.js";
export * as PageController from "./page-controller.js";
export * as DataController from "./data-controller.js";
export * as CollectionSourceController from "./collection-source.js";
export * as CollectionPresentationController from "./collection-presentation.js";
export * as ListingController from "./listing-controller.js";
export * as TableLayoutController from "./table-layout.js";
export {
  BoardLayoutController,
  CalendarLayoutController,
  CardLayoutController,
  ComponentLayoutController,
  ListLayoutController,
  TimelineLayoutController,
  TreeLayoutController,
} from "./listing-layouts.js";
export * as FormController from "./form-controller.js";
export * as ActionController from "./action-controller.js";
export * as FiltersController from "./filters-controller.js";
export * as ComponentController from "./component-controller.js";
export * as ComponentExportController from "./component-export-controller.js";
export * as DesignTokensController from "./design-tokens-controller.js";
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
export {
  HeaderNavigationController,
  OverlayNavigationController,
  SidebarNavigationController,
  TabBarNavigationController,
} from "./navigation.js";
export { FileIconController } from "./icon.js";
