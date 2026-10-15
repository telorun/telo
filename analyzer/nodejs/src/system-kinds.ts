import { isKindDocument } from "./kind-declaration.js";

/**
 * What the passes that skip what is not an instance skip besides a kind
 * document. Which documents declare a kind is answered by `isKindDocument`
 * alone; each pass names only the non-kind built-ins it also skips. Reference
 * validation skips kind documents and nothing else, and the kernel globals'
 * resource enumeration kind documents and the module documents.
 */

/**
 * A kind document, or a `Telo.Import` — skipped by the call graph (and the
 * dependency graph built on it) and by `!ref` sentinel resolution.
 *
 * An import is module wiring, not a runtime node: the dependency graph adds the
 * boot-order edges for what it does hold — the instances its `resources:` hands
 * down and what its `needs:` supplies read — itself. And walking its field map
 * for references is pointless, since no registered kind stands behind it:
 * `resolveRefSentinels` reaches its `resources:` block AHEAD of this skip,
 * deliberately, because those are the references an importer supplies for a
 * library's declared inputs, and nothing else on the document is a reference
 * slot (a `needs:` supply keeps its `!ref` sentinel, read by `needSupplyOf`).
 */
export function isKindDocumentOrImport(doc: { kind?: unknown } | undefined): boolean {
  return isKindDocument(doc) || doc?.kind === "Telo.Import";
}
