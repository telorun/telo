import { isModuleKind } from "@telorun/analyzer";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Document, isMap, isScalar } from "yaml";

/** Mirror LocalFileSource: a directory path resolves to `<dir>/telo.yaml`. */
export function resolveManifestPath(inputPath: string): { filePath: string; error?: string } {
  const resolved = path.resolve(process.cwd(), inputPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    return { filePath: resolved, error: err instanceof Error ? err.message : String(err) };
  }
  if (stat.isDirectory()) {
    return { filePath: path.join(resolved, "telo.yaml") };
  }
  return { filePath: resolved };
}

/**
 * Build a byte-level edit for an import entry's source scalar node.
 * Returns `null` when the parser didn't attach a range to the node — this
 * shouldn't happen for plain `parseAllDocuments` output but we don't want to
 * crash on weird inputs.
 *
 * Quote style is preserved: if the original scalar was written as
 * `Run: "oci://ghcr.io/telorun/run@0.2.4"` we re-emit `"oci://ghcr.io/telorun/run@0.2.7"`; plain stays plain.
 */
export function buildSourceEdit(
  // A yaml v2 Scalar node — typed as unknown here to avoid leaking the
  // import into the public signature of this helper.
  node: unknown,
  content: string,
  newPin: string,
): { start: number; end: number; newText: string } | null {
  if (!node || typeof node !== "object") return null;
  const range = (node as { range?: unknown }).range;
  if (!Array.isArray(range) || range.length < 2) return null;
  const start = range[0] as number;
  const end = range[1] as number;
  if (typeof start !== "number" || typeof end !== "number") return null;

  // Inspect the original byte slice to decide whether to wrap the new value.
  // The parsed scalar's `range[0..1]` covers the quotes (when quoted), so we
  // check the first/last char against `"` and `'` rather than relying on
  // `node.type`, which is fine but adds another yaml-internal dependency.
  const original = content.slice(start, end);
  let newText: string;
  if (original.startsWith('"') && original.endsWith('"')) {
    newText = `"${newPin}"`;
  } else if (original.startsWith("'") && original.endsWith("'")) {
    newText = `'${newPin}'`;
  } else {
    newText = newPin;
  }

  return { start, end, newText };
}

/** The module doc (`Telo.Application` / `Telo.Library`) within a parsed file,
 *  if any. Imports live as an `imports:` map on this doc. */
export function findModuleDoc(docs: Document[]): Document | undefined {
  return docs.find((d) => {
    const kind = d.get("kind");
    return typeof kind === "string" && isModuleKind(kind);
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
