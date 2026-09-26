import type { MonacoApi } from "../lsp-to-monaco";

type Listener<T> = (value: T) => void;

class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  readonly event = (listener: Listener<T>) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
}

class FakeUri {
  readonly scheme: string;
  readonly path: string;
  private readonly href: string;
  constructor(text: string) {
    const url = new URL(text);
    this.scheme = url.protocol.slice(0, -1);
    this.path = decodeURIComponent(url.pathname);
    this.href = url.href;
  }
  toString(): string {
    return this.href;
  }
}

class FakeModel {
  private version = 1;
  private readonly changed = new Emitter<unknown>();
  readonly onDidChangeContent = this.changed.event;
  constructor(
    readonly uri: FakeUri,
    private text: string,
    private readonly language: string,
    private readonly disposeModel: (model: FakeModel) => void,
  ) {}
  getValue(): string {
    return this.text;
  }
  setValue(text: string): void {
    this.text = text;
    this.version += 1;
    this.changed.fire({});
  }
  getOffsetAt(position: { lineNumber: number; column: number }): number {
    const lines = this.text.split("\n");
    let offset = 0;
    for (let i = 0; i < position.lineNumber - 1; i++) offset += lines[i].length + 1;
    return offset + position.column - 1;
  }
  getPositionAt(offset: number): { lineNumber: number; column: number } {
    const before = this.text.slice(0, offset).split("\n");
    return { lineNumber: before.length, column: before[before.length - 1].length + 1 };
  }
  pushStackElement(): void {}
  pushEditOperations(
    selections: unknown,
    operations: Array<{
      range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
      text: string;
    }>,
  ): null {
    const spans = operations
      .map((op) => ({
        start: this.getOffsetAt({ lineNumber: op.range.startLineNumber, column: op.range.startColumn }),
        end: this.getOffsetAt({ lineNumber: op.range.endLineNumber, column: op.range.endColumn }),
        text: op.text,
      }))
      .sort((a, b) => b.start - a.start);
    let text = this.text;
    for (const span of spans) text = text.slice(0, span.start) + span.text + text.slice(span.end);
    this.setValue(text);
    return null;
  }
  getWordUntilPosition(position: { lineNumber: number; column: number }) {
    const line = this.text.split("\n")[position.lineNumber - 1] ?? "";
    const word = /[\w.-]*$/.exec(line.slice(0, position.column - 1))![0];
    return { word, startColumn: position.column - word.length, endColumn: position.column };
  }
  getVersionId(): number {
    return this.version;
  }
  getLanguageId(): string {
    return this.language;
  }
  dispose(): void {
    this.disposeModel(this);
  }
}

/**
 * The slice of Monaco the language bridge and the workspace models use, in
 * memory: models, markers, commands and provider registrations — each
 * registration recorded under its provider kind so a test can read what was
 * registered.
 */
export function fakeMonaco() {
  const models = new Map<string, FakeModel>();
  const created = new Emitter<FakeModel>();
  const disposing = new Emitter<FakeModel>();
  const registered: string[] = [];
  const providers = new Map<string, { selector: unknown; provider: any }>();
  const markers = new Map<string, unknown[]>();
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const provider = (kind: string) => (selector: unknown, implementation: unknown) => {
    registered.push(kind);
    providers.set(kind, { selector, provider: implementation });
    return { dispose: () => registered.splice(registered.indexOf(kind), 1) };
  };
  const monaco = {
    Emitter,
    Uri: { parse: (text: string) => new FakeUri(text) },
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
    MarkerTag: { Unnecessary: 1, Deprecated: 2 },
    editor: {
      getModels: () => [...models.values()],
      getModel: (uri: FakeUri) => models.get(uri.toString()) ?? null,
      createModel: (text: string, language: string, uri: FakeUri) => {
        const model = new FakeModel(uri, text, language, (m) => {
          disposing.fire(m);
          models.delete(m.uri.toString());
        });
        models.set(uri.toString(), model);
        created.fire(model);
        return model;
      },
      onDidCreateModel: created.event,
      onWillDisposeModel: disposing.event,
      onDidChangeModelLanguage: new Emitter<unknown>().event,
      setModelMarkers: (model: FakeModel, owner: string, list: unknown[]) =>
        markers.set(`${owner} ${model.uri.toString()}`, list),
      registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
        commands.set(id, handler);
        return { dispose: () => commands.delete(id) };
      },
    },
    languages: {
      CompletionItemKind: { Text: 18, Property: 9 },
      CompletionItemTag: { Deprecated: 1 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: provider("completion"),
      registerHoverProvider: provider("hover"),
      registerDefinitionProvider: provider("definition"),
      registerRenameProvider: provider("rename"),
      registerSignatureHelpProvider: provider("signatureHelp"),
      registerDocumentSemanticTokensProvider: provider("semanticTokens"),
      registerCodeActionProvider: provider("codeAction"),
      registerCodeLensProvider: provider("codeLens"),
    },
  };
  return { monaco: monaco as unknown as MonacoApi, registered, providers, markers, commands };
}
