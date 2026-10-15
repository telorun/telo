import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { isNeedTypeDoc, needTypeDefinition } from "./need-type.js";

/**
 * Which kind a document declares, and that kind's definition — the one answer
 * every consumer reads instead of testing a document's `kind:` itself.
 *
 * A `Telo.Definition` or `Telo.Abstract` is its own definition. A
 * `Telo.NeedType` declares a kind its document does not spell out — a
 * `Telo.Provider` served by the kernel's need-type controller — so its
 * definition is synthesized, and carries the document's authored `metadata`
 * whole (`deprecated`, `categories`, every descriptive key). Anything else
 * declares no kind.
 *
 * Memoized per document: the same document yields the same definition object,
 * because validators and forms are memoized by schema identity.
 *
 * Browser-safe — no I/O, no Node built-ins.
 */

const synthesized = new WeakMap<object, ResourceDefinition>();

export function kindDeclarationOf(
  doc: { kind?: unknown } | undefined,
): ResourceDefinition | undefined {
  if (!doc) return undefined;
  if (doc.kind === "Telo.Definition" || doc.kind === "Telo.Abstract") {
    return doc as unknown as ResourceDefinition;
  }
  if (!isNeedTypeDoc(doc)) return undefined;
  let definition = synthesized.get(doc);
  if (!definition) {
    definition = needTypeDefinition(doc as unknown as ResourceManifest);
    synthesized.set(doc, definition);
  }
  return definition;
}

/**
 * True when `doc` declares a kind.
 *
 * Such a document's CEL is written for whoever instantiates the kind, not
 * evaluated in the declaring module's own scope: its `examples:` show a
 * consumer's route reading `request` and `result`, its `description`s show
 * `!cel "secrets.API_KEY"`, and a rule condition reads the `self` / `referrer`
 * its own evaluator binds. Every check asking "is this name in scope here"
 * stands down on these documents, or it reports errors nobody can fix without
 * deleting the example.
 */
export function isKindDocument(doc: { kind?: unknown } | undefined): boolean {
  return kindDeclarationOf(doc) !== undefined;
}
