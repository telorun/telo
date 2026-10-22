/**
 * The conformance checks a theme or controls module runs from its own tests.
 * One namespace per kind; each kind's `controllers:` candidate selects one by
 * PURL fragment, so the whole module is one bundle — which is also what a
 * check's window re-enters in its worker.
 */
import "./conformance-worker.js";

export * as CheckThemeController from "./check-theme-controller.js";
export * as CheckControlsController from "./check-controls-controller.js";
