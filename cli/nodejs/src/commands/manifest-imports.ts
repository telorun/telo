import { type Document, isMap, isScalar } from "yaml";

const MODULE_KINDS = new Set(["Telo.Application", "Telo.Library"]);

/** The module doc (`Telo.Application` / `Telo.Library`) within a parsed file,
 *  if any. Imports live as an `imports:` map on this doc. */
export function findModuleDoc(docs: Document[]): Document | undefined {
  return docs.find((d) => {
    const kind = d.get("kind");
    return typeof kind === "string" && MODULE_KINDS.has(kind);
  });
}

export interface ImportSourceRef {
  alias: string;
  /** Current source string value. */
  source: string;
  /** Object-form `integrity:` sibling value, when present. The scalar form
   *  carries integrity inside `source` (a `#sha256-...` fragment) instead, so
   *  this is only set for the object form. A caller pinning imports must treat
   *  either representation as an existing author pin. */
  integrity?: string;
  /** The YAML Scalar node holding the source value — carries `.range`, used
   *  for byte-level splices that preserve quote style and unrelated bytes. */
  node: unknown;
  /** Path into the module doc for AST writes via `Document.setIn`. */
  path: string[];
}

/**
 * Every import entry's source scalar in the module doc's `imports:` map.
 * Handles both the scalar shorthand (`Alias: <src>`) and the object form
 * (`Alias: { source: <src>, … }`). The returned `node`/`path` let callers
 * edit the source in place — byte-splice via `node.range` (upgrade) or
 * AST write via `setIn(path, …)` (publish canonicalization).
 */
export function importSourceRefs(moduleDoc: Document): ImportSourceRef[] {
  const importsNode = moduleDoc.get("imports", true);
  if (!isMap(importsNode)) return [];

  const out: ImportSourceRef[] = [];
  for (const pair of importsNode.items) {
    const alias = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    const value = pair.value;
    if (isScalar(value)) {
      if (typeof value.value !== "string") continue;
      out.push({ alias, source: value.value, node: value, path: ["imports", alias] });
    } else if (isMap(value)) {
      const sourceNode = value.get("source", true);
      if (isScalar(sourceNode) && typeof sourceNode.value === "string") {
        const integrityNode = value.get("integrity", true);
        const integrity =
          isScalar(integrityNode) && typeof integrityNode.value === "string"
            ? integrityNode.value
            : undefined;
        out.push({
          alias,
          source: sourceNode.value,
          integrity,
          node: sourceNode,
          path: ["imports", alias, "source"],
        });
      }
    }
  }
  return out;
}
