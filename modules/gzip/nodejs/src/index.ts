/**
 * Gzip codec — Uint8Array stream ↔ Uint8Array stream. Encoder wraps
 * `zlib.createGzip()` (compress); Decoder wraps `zlib.createGunzip()`
 * (decompress).
 */

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as DecoderController from "./decoder-controller.js";
export * as EncoderController from "./encoder-controller.js";
