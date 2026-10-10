/**
 * Server-Sent Events codec — event-record stream ↔ byte iterables. The encoder
 * frames records for the wire; the decoder parses frames back out of it,
 * emitting each one as it arrives rather than collecting to the end.
 */

// The surface a dependent module's controller reaches through
// `@telorun/sse-codec`: the frame and comment writers, for a transport that
// writes its own event stream rather than encoding a handler's, and the frame
// reader the decoder runs, for a controller that reads one.
export { sseComment, sseFrame } from "./sse-frame.js";
export { readSseRecords, type SseReadBounds, type SseRecord } from "./sse-records.js";

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as DecoderController from "./decoder-controller.js";
export * as EncoderController from "./encoder-controller.js";
