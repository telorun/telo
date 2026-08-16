/**
 * Raw-bytes codec — Uint8Array stream ↔ Uint8Array. Encoder is identity
 * pass-through; Decoder collects to a single Uint8Array.
 */

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as DecoderController from "./decoder-controller.js";
export * as EncoderController from "./encoder-controller.js";
