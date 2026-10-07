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

export * as ViewController from "./view-controller.js";
export * as TableController from "./table-controller.js";
export * as FormController from "./form-controller.js";
export * as FiltersController from "./filters-controller.js";
export * as ComponentController from "./component-controller.js";
export * as ComponentExportController from "./component-export-controller.js";
export * as ThemeController from "./theme-controller.js";
