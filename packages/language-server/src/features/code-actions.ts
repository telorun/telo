import type { TeloDiagnosticData } from "@telorun/editor-protocol";
import { firedLibraryMigrationCodes, libraryMigrationFix, renderFixReplacement } from "@telorun/ide-support";
import { CodeActionKind, type CodeAction, type Diagnostic, type TextEdit } from "vscode-languageserver/browser";
import type { FeatureContext } from "./context.js";
import { canonicalDocumentUri, sourceOfUri, uriOfSource } from "../document-uri.js";

/**
 * The analyzer's repair as a quick fix. It arrives in `Diagnostic.data`, which
 * the client hands back verbatim, so nothing has to stay in sync with
 * re-analysis. The edit is a whole-value replacement of the diagnostic's range,
 * re-quoted through `renderFixReplacement` so every host writes a repaired
 * scalar identically; a span that cannot be rewritten safely (a block scalar)
 * gets no action rather than one that breaks the document.
 */
export function registerCodeActions({ connection, documents, session }: FeatureContext): void {
  connection.onCodeAction((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    const actions: CodeAction[] = [];
    actions.push(...libraryMigrationActions(session, params.textDocument.uri, params.context.diagnostics));
    for (const diagnostic of params.context.diagnostics) {
      const fix = (diagnostic.data as TeloDiagnosticData | undefined)?.fix;
      if (!fix) continue;
      const replacement = renderFixReplacement(
        document.getText(diagnostic.range),
        fix.replacement,
        fix.tag,
      );
      if (replacement === undefined) continue;
      actions.push({
        title: `Replace with ${singleLine(replacement)}`,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        // The analyzer stamps a repair only when it can decide one, so there is
        // never a second candidate for the same diagnostic.
        isPreferred: true,
        edit: {
          changes: {
            [canonicalDocumentUri(params.textDocument.uri)]: [{ range: diagnostic.range, newText: replacement }],
          },
        },
      });
    }
    return actions;
  });
}

/** Action titles sit on one line; a multi-line CEL replacement would otherwise
 *  render with its newlines swallowed. */
function singleLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

/**
 * The library migrations of the document's module as one quick fix, offered on a
 * diagnostic one of them raised and only when `telo migrate` could write every
 * node of them: the edit set is the same one the command writes.
 */
function libraryMigrationActions(
  session: FeatureContext["session"],
  uri: string,
  diagnostics: readonly Diagnostic[],
): CodeAction[] {
  const source = sourceOfUri(uri);
  const { graph } = session.documentAnalysis(source);
  if (!graph) return [];
  const fired = firedLibraryMigrationCodes(graph);
  const raised = diagnostics.filter((d) => typeof d.code === "string" && fired.has(d.code));
  if (raised.length === 0) return [];
  const fix = libraryMigrationFix(graph, source);
  if (!fix) return [];
  const changes: Record<string, TextEdit[]> = {};
  for (const [file, edits] of fix.changes) {
    changes[uriOfSource(file)] = edits.map((edit) => ({ range: { start: edit.start, end: edit.end }, newText: edit.newText }));
  }
  return [{ title: fix.title, kind: CodeActionKind.QuickFix, diagnostics: raised, edit: { changes } }];
}
