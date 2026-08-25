/**
 * A typeface declared once and used everywhere it is needed — embedded by a
 * document, served by a page, measured by a layout.
 *
 * The split is between IDENTITY plus bytes (`Font.Family`, held and read) and
 * MEASUREMENT (`Font.Measure`, invoked with a batch of strings). A family is
 * configuration; measuring is an operation with a declared contract, which is
 * what lets a caller in any language ask how wide its text will be.
 */

// The surface a dependent module's controller reaches through `@telorun/font`:
// how to read a family it holds a reference to, and how to guess a width when
// that family declared no bytes. Both are things a consumer would otherwise
// re-implement, and the estimate is one nobody would notice diverging.
export { FACES, isFace, isFamilyHandle, selectFace } from "./face.js";
export type { Face, Faces, FamilyHandle } from "./face.js";
export { estimateVertical, estimateWidth } from "./estimate.js";

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as FamilyController from "./family-controller.js";
export * as MeasureController from "./measure-controller.js";
