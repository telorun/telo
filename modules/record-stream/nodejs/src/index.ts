/**
 * record-stream — generic stream operations on structured records.
 * ExtractText (records → strings), Tee (fan-out), OnComplete (end-of-stream
 * side effect), and the Journal family (JournalStore + Sink/Source) for
 * resumable, offset-addressable replay of a detached stream.
 */
export { JournalStore, isJournalStore } from "./journal-store.js";
export type { JournalEntry } from "./journal-store.js";

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as ExtractTextController from "./extract-text-controller.js";
export * as JournalController from "./journal-controller.js";
export * as JournalSinkController from "./journal-sink-controller.js";
export * as JournalSourceController from "./journal-source-controller.js";
export * as OnCompleteController from "./on-complete-controller.js";
export * as TeeController from "./tee-controller.js";
