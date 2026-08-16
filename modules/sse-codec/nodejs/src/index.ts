/**
 * Server-Sent Events codec — event-record stream ↔ byte iterables. The encoder
 * is exported from `./encoder`. A frame-buffered, stream-out decoder is planned
 * but not yet shipped.
 */

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as EncoderController from "./encoder-controller.js";
