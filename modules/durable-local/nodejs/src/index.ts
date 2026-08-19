/**
 * The module's single entry point — one namespace per kind, which is what the
 * controller PURLs' `#fragment`s select out of the one bundle this module ships.
 *
 * One bundle per module is not a packaging preference: a bundle is a module
 * graph, so a shared source file compiled into two bundles is two module scopes.
 * Here that would be load-bearing rather than theoretical — the workflow and the
 * resumer share the journal contract and the run handle, and the resumer reaches
 * the workflow's own `execute` so that resuming is not a second implementation
 * of replay.
 */
export * as workflow from "./workflow.js";
export * as resumer from "./resumer.js";
export type { DurableJournal, JournalEntry, RunRecord } from "./journal.js";
