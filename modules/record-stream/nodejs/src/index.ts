/**
 * record-stream — generic stream operations on structured records.
 * ExtractText (records → strings), Tee (fan-out), OnComplete (end-of-stream
 * side effect), and the Journal family for resumable, offset-addressable replay
 * of a detached stream over a pluggable store.
 *
 * Also the `@telorun/record-stream` module library: the store contract a
 * backend implements, and the journal protocol written once above it.
 */
export { isJournalStore } from "./journal-store-contract.js";
export type {
  JournalHeader,
  JournalPage,
  JournalScan,
  JournalStore,
  JournalStoreEntry,
  ScannedHeader,
} from "./journal-store-contract.js";
export {
  ERR_JOURNAL_KEY_BUSY,
  ERR_JOURNAL_KEY_REMOVED,
  ERR_JOURNAL_WRITER_LOST,
  Journal,
  JournalReader,
  JournalWriter,
  isJournal,
} from "./journal.js";
export type { JournalEntry, JournalSettings } from "./journal.js";

// Controller entry points. Each kind's `controllers:` candidate selects one of
// these by PURL fragment, so the whole module is one bundle and its shared
// state is one module scope.
export * as ExtractTextController from "./extract-text-controller.js";
export * as JournalController from "./journal-controller.js";
export * as JournalExpiryController from "./journal-expiry-controller.js";
export * as JournalRemovalController from "./journal-removal-controller.js";
export * as JournalSinkController from "./journal-sink-controller.js";
export * as JournalSourceController from "./journal-source-controller.js";
export * as MemoryJournalStoreController from "./memory-journal-store.js";
export * as OnCompleteController from "./on-complete-controller.js";
export * as TeeController from "./tee-controller.js";
