import type { ModuleDocument } from "../../../model";
import { moduleParseError, parseModuleDocument } from "../../../yaml-document";

/** Commit a document's text to the workspace — the one write path for text
 *  typed in the source view or the resource YAML pane. Unparseable text is
 *  never committed, since it would take the whole module's AST down with it;
 *  its parse error is answered instead. */
export function commitSourceText(
  filePath: string,
  text: string,
  onSourceEdit: (filePath: string, moduleDoc: ModuleDocument) => void,
): string | null {
  const moduleDoc = parseModuleDocument(filePath, text);
  const error = moduleParseError(moduleDoc);
  if (error) return error;
  onSourceEdit(filePath, moduleDoc);
  return null;
}
