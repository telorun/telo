/**
 * Plain-text codec — UTF-8 string ↔ byte iterables. Each controller exported
 * from its own subpath (./encoder, ./decoder).
 */

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as DecoderController from "./decoder-controller.js";
export * as EncoderController from "./encoder-controller.js";
