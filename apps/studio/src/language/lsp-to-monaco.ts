import type * as Monaco from "monaco-editor";
import type {
  CodeAction,
  Command,
  CompletionItem,
  Diagnostic,
  Hover,
  InsertReplaceEdit,
  Location,
  LocationLink,
  MarkedString,
  MarkupContent,
  Position,
  Range,
  SignatureHelp,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver-protocol";

/** The Monaco namespace as the bridge uses it — the editor's own runtime,
 *  handed over by whoever loaded it. */
export type MonacoApi = typeof Monaco;

/** LSP → Monaco translation, one function per shape. Protocol lines and
 *  characters are 0-based, Monaco's 1-based. */

export function toMonacoRange(range: Range): Monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

export function toLspPosition(position: Monaco.IPosition): Position {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

export function toLspRange(range: Monaco.IRange): Range {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}

export function toMarker(monaco: MonacoApi, d: Diagnostic): Monaco.editor.IMarkerData {
  const severity =
    d.severity === 2
      ? monaco.MarkerSeverity.Warning
      : d.severity === 3
        ? monaco.MarkerSeverity.Info
        : d.severity === 4
          ? monaco.MarkerSeverity.Hint
          : monaco.MarkerSeverity.Error;
  const tags = (d.tags ?? []).flatMap((t) =>
    t === 1 ? [monaco.MarkerTag.Unnecessary] : t === 2 ? [monaco.MarkerTag.Deprecated] : [],
  );
  return {
    ...toMonacoRange(d.range),
    severity,
    message: diagnosticMessage(d),
    ...(d.source ? { source: d.source } : {}),
    ...(d.code !== undefined ? { code: String(d.code) } : {}),
    ...(tags.length ? { tags } : {}),
  };
}

/** A diagnostic's message as text — LSP 3.18 lets it be markup. */
export function diagnosticMessage(d: Diagnostic): string {
  return typeof d.message === "string" ? d.message : d.message.value;
}

/** Whether a marker Monaco hands back (a code action's context) stands for `d`. */
export function markerMatches(marker: Monaco.editor.IMarkerData, d: Diagnostic): boolean {
  const r = toMonacoRange(d.range);
  return (
    marker.message === diagnosticMessage(d) &&
    marker.startLineNumber === r.startLineNumber &&
    marker.startColumn === r.startColumn &&
    marker.endLineNumber === r.endLineNumber &&
    marker.endColumn === r.endColumn
  );
}

export function toMarkdown(content: string | MarkupContent | MarkedString): Monaco.IMarkdownString {
  if (typeof content === "string") return { value: content };
  if ("kind" in content) {
    return { value: content.kind === "markdown" ? content.value : escapeMarkdown(content.value) };
  }
  return { value: `\`\`\`${content.language}\n${content.value}\n\`\`\`` };
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

function toDocumentation(
  documentation: string | MarkupContent | undefined,
): string | Monaco.IMarkdownString | undefined {
  if (documentation === undefined || typeof documentation === "string") return documentation;
  return toMarkdown(documentation);
}

export function toCommand(command: Command): Monaco.languages.Command {
  return { id: command.command, title: command.title, ...(command.arguments ? { arguments: command.arguments } : {}) };
}

/** LSP `CompletionItemKind` (1-based) by name, read as Monaco's enum. */
const COMPLETION_KIND_NAMES = [
  "Text", "Method", "Function", "Constructor", "Field", "Variable", "Class", "Interface",
  "Module", "Property", "Unit", "Value", "Enum", "Keyword", "Snippet", "Color", "File",
  "Reference", "Folder", "EnumMember", "Constant", "Struct", "Event", "Operator", "TypeParameter",
] as const;

export function toCompletionItem(
  monaco: MonacoApi,
  item: CompletionItem,
  defaultRange: Monaco.IRange,
): Monaco.languages.CompletionItem {
  const kinds = monaco.languages.CompletionItemKind;
  const kindName = item.kind === undefined ? undefined : COMPLETION_KIND_NAMES[item.kind - 1];
  const edit = item.textEdit;
  const range: Monaco.languages.CompletionItem["range"] =
    edit === undefined
      ? defaultRange
      : "range" in edit
        ? toMonacoRange((edit as TextEdit).range)
        : {
            insert: toMonacoRange((edit as InsertReplaceEdit).insert),
            replace: toMonacoRange((edit as InsertReplaceEdit).replace),
          };
  const documentation = toDocumentation(item.documentation);
  return {
    label: item.label,
    kind: kindName ? kinds[kindName] : kinds.Text,
    insertText: edit?.newText ?? item.insertText ?? item.label,
    range,
    ...(item.insertTextFormat === 2
      ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
      : {}),
    ...(item.detail !== undefined ? { detail: item.detail } : {}),
    ...(documentation !== undefined ? { documentation } : {}),
    ...(item.sortText !== undefined ? { sortText: item.sortText } : {}),
    ...(item.filterText !== undefined ? { filterText: item.filterText } : {}),
    ...(item.preselect ? { preselect: true } : {}),
    ...(item.command ? { command: toCommand(item.command) } : {}),
    ...(item.tags?.includes(1) || item.deprecated ? { tags: [monaco.languages.CompletionItemTag.Deprecated] } : {}),
  };
}

export function toHover(hover: Hover): Monaco.languages.Hover {
  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
  return {
    contents: contents.map(toMarkdown),
    ...(hover.range ? { range: toMonacoRange(hover.range) } : {}),
  };
}

export function toLocations(
  monaco: MonacoApi,
  result: Location | Location[] | LocationLink[] | null,
): Monaco.languages.Location[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.map((l) =>
    "targetUri" in l
      ? { uri: monaco.Uri.parse(l.targetUri), range: toMonacoRange(l.targetSelectionRange) }
      : { uri: monaco.Uri.parse(l.uri), range: toMonacoRange(l.range) },
  );
}

/** Every text edit a workspace edit makes, by document. A resource operation
 *  (create / rename / delete a file) is refused: a Monaco model cannot perform
 *  one. */
export function textEditsOf(edit: WorkspaceEdit): Array<{ uri: string; version?: number | null; edits: TextEdit[] }> {
  const out: Array<{ uri: string; version?: number | null; edits: TextEdit[] }> = [];
  for (const change of edit.documentChanges ?? []) {
    if (!("textDocument" in change)) {
      throw new Error(`the editor cannot apply a '${change.kind}' file operation.`);
    }
    out.push({
      uri: change.textDocument.uri,
      version: change.textDocument.version,
      edits: change.edits.filter((e): e is TextEdit => "range" in e && "newText" in e),
    });
  }
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) out.push({ uri, edits });
  return out;
}

export function toWorkspaceEdit(monaco: MonacoApi, edit: WorkspaceEdit): Monaco.languages.WorkspaceEdit {
  return {
    edits: textEditsOf(edit).flatMap(({ uri, edits }) =>
      edits.map((e) => ({
        resource: monaco.Uri.parse(uri),
        textEdit: { range: toMonacoRange(e.range), text: e.newText },
        versionId: undefined,
      })),
    ),
  };
}

export function toCodeAction(
  monaco: MonacoApi,
  action: CodeAction | Command,
  diagnostics: Diagnostic[],
): Monaco.languages.CodeAction {
  if (typeof (action as Command).command === "string") {
    const command = action as Command;
    return { title: command.title, command: toCommand(command) };
  }
  const a = action as CodeAction;
  const markers = (a.diagnostics ?? diagnostics).map((d) => toMarker(monaco, d));
  return {
    title: a.title,
    ...(a.kind ? { kind: a.kind } : {}),
    ...(markers.length ? { diagnostics: markers } : {}),
    ...(a.edit ? { edit: toWorkspaceEdit(monaco, a.edit) } : {}),
    ...(a.command ? { command: toCommand(a.command) } : {}),
    ...(a.isPreferred ? { isPreferred: true } : {}),
  };
}

export function toSignatureHelp(help: SignatureHelp): Monaco.languages.SignatureHelp {
  return {
    signatures: help.signatures.map((s) => {
      const documentation = toDocumentation(s.documentation);
      return {
        label: s.label,
        ...(documentation !== undefined ? { documentation } : {}),
        parameters: (s.parameters ?? []).map((p) => {
          const parameterDocumentation = toDocumentation(p.documentation);
          return {
            label: p.label,
            ...(parameterDocumentation !== undefined ? { documentation: parameterDocumentation } : {}),
          };
        }),
      };
    }),
    activeSignature: help.activeSignature ?? 0,
    activeParameter: help.activeParameter ?? 0,
  };
}
