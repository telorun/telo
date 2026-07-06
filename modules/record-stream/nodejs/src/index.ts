/**
 * record-stream — generic stream operations on structured records.
 * ExtractText (records → strings), Tee (fan-out), OnComplete (end-of-stream
 * side effect), and the Journal family (JournalStore + Sink/Source) for
 * resumable, offset-addressable replay of a detached stream.
 */
export { JournalStore, resolveJournal } from "./journal-store.js";
export type { JournalEntry } from "./journal-store.js";
