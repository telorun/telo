import type * as Monaco from "monaco-editor";
import {
  CancellationTokenSource,
  ResponseError,
  createMessageConnection,
  type ApplyWorkspaceEditParams,
  type ApplyWorkspaceEditResult,
  type ClientCapabilities,
  type CodeAction,
  type CodeLens,
  type Command,
  type CompletionItem,
  type CompletionList,
  type Diagnostic,
  type Hover,
  type InitializeResult,
  type Location,
  type LocationLink,
  type MessageConnection,
  type MessageReader,
  type MessageWriter,
  type Position,
  type PrepareRenameResult,
  type PublishDiagnosticsParams,
  type Range,
  type RegistrationParams,
  type SemanticTokens,
  type ServerCapabilities,
  type SignatureHelp,
  type UnregistrationParams,
  type WorkspaceEdit,
} from "vscode-languageserver-protocol";
import {
  markerMatches,
  textEditsOf,
  toCodeAction,
  toCommand,
  toCompletionItem,
  toHover,
  toLocations,
  toLspPosition,
  toLspRange,
  toMarker,
  toMonacoRange,
  toSignatureHelp,
  toWorkspaceEdit,
  type MonacoApi,
} from "./lsp-to-monaco";
import type { ModelProjection, ModelProjections } from "./model-projections";

export interface MonacoLspBridgeOptions {
  monaco: MonacoApi;
  /** The editor's end of an LSP connection. */
  transports: { reader: MessageReader; writer: MessageWriter };
  /** The models the server sees, and the ones its features serve. */
  documents: { language: string; scheme: string };
  /** Models showing part of a document, served through their source (never
   *  opened on the server themselves). */
  projections?: ModelProjections;
  /** Owner of the markers the server's diagnostics become. */
  markerOwner: string;
  clientName: string;
  /** Every diagnostics publication, for surfaces beyond the text editor. */
  onDiagnostics(uri: string, diagnostics: Diagnostic[]): void;
  /** What the server logs, and what it asks to show the user. */
  onMessage(type: 1 | 2 | 3 | 4, message: string, shown: boolean): void;
}

const CLIENT_CAPABILITIES: ClientCapabilities = {
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false },
    completion: {
      dynamicRegistration: true,
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        insertReplaceSupport: true,
        documentationFormat: ["markdown", "plaintext"],
        deprecatedSupport: true,
        tagSupport: { valueSet: [1] },
      },
    },
    hover: { dynamicRegistration: true, contentFormat: ["markdown", "plaintext"] },
    definition: { dynamicRegistration: true, linkSupport: true },
    rename: { dynamicRegistration: true, prepareSupport: true },
    signatureHelp: {
      dynamicRegistration: true,
      signatureInformation: {
        documentationFormat: ["markdown", "plaintext"],
        parameterInformation: { labelOffsetSupport: true },
      },
    },
    semanticTokens: {
      dynamicRegistration: true,
      requests: { full: true },
      tokenTypes: [],
      tokenModifiers: [],
      formats: ["relative"],
    },
    codeAction: {
      dynamicRegistration: true,
      codeActionLiteralSupport: {
        codeActionKind: { valueSet: ["quickfix", "refactor", "source"] },
      },
    },
    codeLens: { dynamicRegistration: true },
    publishDiagnostics: { tagSupport: { valueSet: [1, 2] }, dataSupport: true },
  },
  workspace: {
    applyEdit: true,
    workspaceEdit: { documentChanges: true },
    codeLens: { refreshSupport: true },
    semanticTokens: { refreshSupport: true },
    executeCommand: { dynamicRegistration: true },
  },
  window: { showMessage: {} },
};

/** The features this bridge maps onto Monaco: the method a dynamic
 *  registration names, and the capability a static one is advertised under. */
const FEATURES: Record<string, keyof ServerCapabilities> = {
  "textDocument/completion": "completionProvider",
  "textDocument/hover": "hoverProvider",
  "textDocument/definition": "definitionProvider",
  "textDocument/rename": "renameProvider",
  "textDocument/signatureHelp": "signatureHelpProvider",
  "textDocument/semanticTokens": "semanticTokensProvider",
  "textDocument/codeAction": "codeActionProvider",
  "textDocument/codeLens": "codeLensProvider",
  "workspace/executeCommand": "executeCommandProvider",
};

/**
 * Monaco as an LSP client — language-agnostic.
 *
 * Documents are Monaco models: every model matching `documents` is opened on
 * the server when it exists, synchronised as full text on every change, and
 * closed when it is disposed. Published diagnostics become markers on their
 * model (and reach `onDiagnostics` for every other surface). Providers are
 * registered only for the capabilities the server advertised — in `initialize`,
 * or later through `client/registerCapability`, withdrawn by
 * `client/unregisterCapability` — so an editor never offers a feature its
 * server cannot answer; commands the server executes are registered as Monaco
 * commands, and its `workspace/applyEdit` requests edit the models.
 *
 * A projected model (`projections`) is served by the same providers without
 * ever being opened: each request is asked of its source document at the
 * mapped position, ranges come back mapped and whatever falls outside the
 * projection is dropped, locations and edits stay addressed to the source, and
 * its markers are painted from the source's publications.
 */
export class MonacoLspBridge {
  private readonly monaco: MonacoApi;
  private readonly connection: MessageConnection;
  private readonly disposables: Monaco.IDisposable[] = [];
  /** Providers registered dynamically, by registration id. */
  private readonly registered = new Map<string, Monaco.IDisposable[]>();
  private readonly open = new Map<string, Monaco.IDisposable>();
  private readonly diagnostics = new Map<string, Diagnostic[]>();
  private readonly lensesChanged: Monaco.Emitter<Monaco.languages.CodeLensProvider>;
  private lensProvider: Monaco.languages.CodeLensProvider | undefined;
  private readonly tokensChanged: Monaco.Emitter<void>;
  private capabilities: ServerCapabilities = {};
  private disposed = false;

  private constructor(private readonly options: MonacoLspBridgeOptions) {
    this.monaco = options.monaco;
    this.lensesChanged = new options.monaco.Emitter<Monaco.languages.CodeLensProvider>();
    this.tokensChanged = new options.monaco.Emitter<void>();
    this.connection = createMessageConnection(options.transports.reader, options.transports.writer);
    this.connection.onNotification("textDocument/publishDiagnostics", (params: PublishDiagnosticsParams) =>
      this.publish(params),
    );
    this.connection.onNotification("window/logMessage", (p: { type: 1 | 2 | 3 | 4; message: string }) =>
      options.onMessage(p.type, p.message, false),
    );
    this.connection.onNotification("window/showMessage", (p: { type: 1 | 2 | 3 | 4; message: string }) =>
      options.onMessage(p.type, p.message, true),
    );
    this.connection.onRequest("workspace/applyEdit", (p: ApplyWorkspaceEditParams) => this.applyEdit(p.edit));
    this.connection.onRequest("workspace/codeLens/refresh", () => {
      if (this.lensProvider) this.lensesChanged.fire(this.lensProvider);
      return null;
    });
    this.connection.onRequest("workspace/semanticTokens/refresh", () => {
      this.tokensChanged.fire();
      return null;
    });
    this.connection.onRequest("client/registerCapability", (p: RegistrationParams) => {
      for (const r of p.registrations) {
        if (this.disposed || !(r.method in FEATURES)) continue;
        this.registered.set(r.id, this.registerFeature(r.method, r.registerOptions ?? {}));
      }
      return null;
    });
    this.connection.onRequest("client/unregisterCapability", (p: UnregistrationParams) => {
      for (const u of p.unregisterations) {
        for (const d of this.registered.get(u.id) ?? []) d.dispose();
        this.registered.delete(u.id);
      }
      return null;
    });
    this.connection.onRequest("window/showMessageRequest", (p: { type: 1 | 2 | 3 | 4; message: string }) => {
      options.onMessage(p.type, p.message, true);
      return null;
    });
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.connection.listen();
  }

  /** Connects, initializes, registers the advertised features and opens every
   *  matching model. */
  static async start(options: MonacoLspBridgeOptions): Promise<MonacoLspBridge> {
    const bridge = new MonacoLspBridge(options);
    const result: InitializeResult = await bridge.connection.sendRequest("initialize", {
      processId: null,
      clientInfo: { name: options.clientName },
      rootUri: null,
      capabilities: CLIENT_CAPABILITIES,
    });
    await bridge.connection.sendNotification("initialized", {});
    bridge.capabilities = result.capabilities;
    bridge.registerFeatures();
    bridge.syncModels();
    return bridge;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of this.disposables) d.dispose();
    for (const list of this.registered.values()) for (const d of list) d.dispose();
    this.registered.clear();
    for (const d of this.open.values()) d.dispose();
    this.open.clear();
    for (const model of this.monaco.editor.getModels()) {
      this.monaco.editor.setModelMarkers(model, this.options.markerOwner, []);
    }
    await this.connection.sendRequest("shutdown");
    await this.connection.sendNotification("exit");
    this.connection.dispose();
  }

  // --- documents --------------------------------------------------------------

  private matches(model: Monaco.editor.ITextModel): boolean {
    return (
      model.uri.scheme === this.options.documents.scheme &&
      model.getLanguageId() === this.options.documents.language
    );
  }

  private syncModels(): void {
    const { editor } = this.monaco;
    for (const model of editor.getModels()) this.openModel(model);
    this.disposables.push(
      editor.onDidCreateModel((model) => this.openModel(model)),
      editor.onWillDisposeModel((model) => this.closeModel(model)),
      editor.onDidChangeModelLanguage(({ model }) => {
        if (this.matches(model)) this.openModel(model);
        else this.closeModel(model);
      }),
    );
  }

  private openModel(model: Monaco.editor.ITextModel): void {
    const uri = model.uri.toString();
    if (!this.matches(model) || this.open.has(uri)) return;
    this.open.set(
      uri,
      model.onDidChangeContent(() =>
        this.notify("textDocument/didChange", {
          textDocument: { uri, version: model.getVersionId() },
          contentChanges: [{ text: model.getValue() }],
        }),
      ),
    );
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: model.getLanguageId(), version: model.getVersionId(), text: model.getValue() },
    });
    const known = this.diagnostics.get(uri);
    if (known) this.monaco.editor.setModelMarkers(model, this.options.markerOwner, known.map((d) => toMarker(this.monaco, d)));
  }

  private closeModel(model: Monaco.editor.ITextModel): void {
    const uri = model.uri.toString();
    const listener = this.open.get(uri);
    if (!listener) return;
    listener.dispose();
    this.open.delete(uri);
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  private notify(method: string, params: unknown): void {
    this.connection.sendNotification(method, params).catch((error) =>
      this.options.onMessage(1, `could not send ${method} to the language server: ${errorText(error)}`, false),
    );
  }

  private publish({ uri, diagnostics }: PublishDiagnosticsParams): void {
    const key = this.monaco.Uri.parse(uri).toString();
    this.diagnostics.set(key, diagnostics);
    const model = this.monaco.editor.getModel(this.monaco.Uri.parse(uri));
    if (model) {
      this.monaco.editor.setModelMarkers(model, this.options.markerOwner, diagnostics.map((d) => toMarker(this.monaco, d)));
    }
    for (const projection of this.options.projections?.all() ?? []) {
      if (this.monaco.Uri.parse(projection.source).toString() === key) this.paintProjection(projection);
    }
    this.options.onDiagnostics(uri, diagnostics);
  }

  private applyEdit(edit: WorkspaceEdit): ApplyWorkspaceEditResult {
    let documents: ReturnType<typeof textEditsOf>;
    try {
      documents = textEditsOf(edit);
    } catch (error) {
      return { applied: false, failureReason: errorText(error) };
    }
    const targets = documents.map(({ uri, edits }) => ({
      model: this.monaco.editor.getModel(this.monaco.Uri.parse(uri)),
      uri,
      edits,
    }));
    const missing = targets.find((t) => !t.model);
    if (missing) return { applied: false, failureReason: `${missing.uri} is not open in the editor.` };
    for (const { model, edits } of targets) {
      model!.pushStackElement();
      model!.pushEditOperations(
        [],
        edits.map((e) => ({ range: toMonacoRange(e.range), text: e.newText })),
        () => null,
      );
      model!.pushStackElement();
    }
    return { applied: true };
  }

  // --- features ---------------------------------------------------------------

  /** A request tied to Monaco's cancellation; a cancelled request answers
   *  nothing rather than an error. */
  private async request<R>(method: string, params: unknown, token: Monaco.CancellationToken): Promise<R | undefined> {
    const source = new CancellationTokenSource();
    const listener = token.onCancellationRequested(() => source.cancel());
    try {
      return await this.connection.sendRequest<R>(method, params, source.token);
    } catch (error) {
      if (token.isCancellationRequested) return undefined;
      throw error;
    } finally {
      listener.dispose();
      source.dispose();
    }
  }

  /** Where a request about `model` is asked, and how its positions move: the
   *  document itself, or a projection's source document. */
  private target(model: Monaco.editor.ITextModel): Target | undefined {
    if (this.matches(model)) return { uri: model.uri.toString(), out: (p) => p, back: (p) => p };
    const projection = this.options.projections?.get(model);
    if (!projection) return undefined;
    return {
      uri: projection.source,
      out: (p) => projection.toSource(p),
      back: (p) => projection.fromSource(p),
    };
  }

  private paintProjection(projection: ModelProjection): void {
    const published = this.diagnostics.get(this.monaco.Uri.parse(projection.source).toString()) ?? [];
    const back = (p: Position) => projection.fromSource(p);
    this.monaco.editor.setModelMarkers(
      projection.model,
      this.options.markerOwner,
      published.flatMap((d) => {
        const mapped = mapDiagnostic(d, back);
        return mapped ? [toMarker(this.monaco, mapped)] : [];
      }),
    );
  }

  private registerFeatures(): void {
    const projections = this.options.projections;
    if (projections) {
      this.disposables.push(projections.onDidChange((projection) => this.paintProjection(projection)));
      for (const projection of projections.all()) this.paintProjection(projection);
    }
    for (const [method, capability] of Object.entries(FEATURES)) {
      const options = this.capabilities[capability];
      if (options) this.disposables.push(...this.registerFeature(method, options === true ? {} : options));
    }
  }

  /** The Monaco providers (or commands) serving one feature with `options`. */
  private registerFeature(method: string, options: any): Monaco.IDisposable[] {
    const { languages, editor } = this.monaco;
    const { language, scheme } = this.options.documents;
    const projections = this.options.projections;
    const selector: Monaco.languages.LanguageSelector = [
      { language, scheme },
      ...(projections ? [{ language, scheme: projections.scheme }] : []),
    ];
    switch (method) {
      case "textDocument/completion":
        return [
          languages.registerCompletionItemProvider(selector, {
            triggerCharacters: options.triggerCharacters,
            provideCompletionItems: async (model, position, context, token) => {
              const target = this.target(model);
              if (!target) return { suggestions: [] };
              const result = await this.request<CompletionItem[] | CompletionList | null>(
                "textDocument/completion",
                {
                  textDocument: { uri: target.uri },
                  position: target.out(toLspPosition(position)),
                  context: {
                    triggerKind: context.triggerKind + 1,
                    ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}),
                  },
                },
                token,
              );
              const word = model.getWordUntilPosition(position);
              const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
              };
              const items = !result ? [] : Array.isArray(result) ? result : result.items;
              return {
                suggestions: items.flatMap((item) => {
                  const mapped = mapCompletionItem(item, target.back);
                  return mapped ? [toCompletionItem(this.monaco, mapped, range)] : [];
                }),
                incomplete: !!result && !Array.isArray(result) && result.isIncomplete,
              };
            },
          }),
        ];

      case "textDocument/hover":
        return [
          languages.registerHoverProvider(selector, {
            provideHover: async (model, position, token) => {
              const target = this.target(model);
              if (!target) return undefined;
              const hover = await this.request<Hover | null>(
                "textDocument/hover",
                { textDocument: { uri: target.uri }, position: target.out(toLspPosition(position)) },
                token,
              );
              if (!hover) return undefined;
              const range = hover.range && mapRange(hover.range, target.back);
              return toHover({ contents: hover.contents, ...(range ? { range } : {}) });
            },
          }),
        ];

      case "textDocument/definition":
        return [
          languages.registerDefinitionProvider(selector, {
            // Locations stay addressed to the documents they name.
            provideDefinition: async (model, position, token) => {
              const target = this.target(model);
              if (!target) return [];
              return toLocations(
                this.monaco,
                (await this.request<Location | Location[] | LocationLink[] | null>(
                  "textDocument/definition",
                  { textDocument: { uri: target.uri }, position: target.out(toLspPosition(position)) },
                  token,
                )) ?? null,
              );
            },
          }),
        ];

      case "textDocument/rename": {
        const prepare = options.prepareProvider === true;
        return [
          languages.registerRenameProvider(selector, {
            // The edit stays addressed to the source document; a projection
            // follows the source it shows.
            provideRenameEdits: async (model, position, newName, token) => {
              const target = this.target(model);
              if (!target) return { edits: [] };
              try {
                const edit = await this.request<WorkspaceEdit | null>(
                  "textDocument/rename",
                  { textDocument: { uri: target.uri }, position: target.out(toLspPosition(position)), newName },
                  token,
                );
                return edit ? toWorkspaceEdit(this.monaco, edit) : { edits: [] };
              } catch (error) {
                if (error instanceof ResponseError) return { edits: [], rejectReason: error.message };
                throw error;
              }
            },
            ...(prepare
              ? {
                  resolveRenameLocation: async (model, position, token) => {
                    const word = model.getWordAtPosition(position);
                    const wordRange = {
                      startLineNumber: position.lineNumber,
                      endLineNumber: position.lineNumber,
                      startColumn: word?.startColumn ?? position.column,
                      endColumn: word?.endColumn ?? position.column,
                    };
                    const refuse = (rejectReason: string) => ({ range: wordRange, text: word?.word ?? "", rejectReason });
                    const target = this.target(model);
                    if (!target) return refuse("This element cannot be renamed.");
                    let result: PrepareRenameResult | null | undefined;
                    try {
                      result = await this.request<PrepareRenameResult | null>(
                        "textDocument/prepareRename",
                        { textDocument: { uri: target.uri }, position: target.out(toLspPosition(position)) },
                        token,
                      );
                    } catch (error) {
                      if (error instanceof ResponseError) return refuse(error.message);
                      throw error;
                    }
                    if (!result) return refuse("This element cannot be renamed.");
                    if ("defaultBehavior" in result) return { range: wordRange, text: word?.word ?? "" };
                    const range = mapRange("range" in result ? result.range : result, target.back);
                    if (!range) return refuse("The name to rename lies outside this editor.");
                    const r = toMonacoRange(range);
                    return {
                      range: r,
                      text: "placeholder" in result ? result.placeholder : model.getValueInRange(r),
                    };
                  },
                }
              : {}),
          }),
        ];
      }

      case "textDocument/signatureHelp":
        return [
          languages.registerSignatureHelpProvider(selector, {
            signatureHelpTriggerCharacters: options.triggerCharacters,
            signatureHelpRetriggerCharacters: options.retriggerCharacters,
            provideSignatureHelp: async (model, position, token) => {
              const target = this.target(model);
              if (!target) return undefined;
              const help = await this.request<SignatureHelp | null>(
                "textDocument/signatureHelp",
                { textDocument: { uri: target.uri }, position: target.out(toLspPosition(position)) },
                token,
              );
              return help ? { value: toSignatureHelp(help), dispose: () => undefined } : undefined;
            },
          }),
        ];

      case "textDocument/semanticTokens": {
        if (!options.full) return [];
        const legend = options.legend as { tokenTypes: string[]; tokenModifiers: string[] };
        return [
          languages.registerDocumentSemanticTokensProvider(selector, {
            onDidChange: this.tokensChanged.event,
            getLegend: () => ({ tokenTypes: legend.tokenTypes, tokenModifiers: legend.tokenModifiers }),
            provideDocumentSemanticTokens: async (model, lastResultId, token) => {
              const target = this.target(model);
              if (!target) return null;
              const result = await this.request<SemanticTokens | null>(
                "textDocument/semanticTokens/full",
                { textDocument: { uri: target.uri } },
                token,
              );
              if (!result) return null;
              if (target.uri === model.uri.toString()) {
                return { data: Uint32Array.from(result.data), ...(result.resultId ? { resultId: result.resultId } : {}) };
              }
              return { data: Uint32Array.from(mapSemanticTokens(result.data, target.back)) };
            },
            releaseDocumentSemanticTokens: () => undefined,
          }),
        ];
      }

      case "textDocument/codeAction":
        return [
          languages.registerCodeActionProvider(selector, {
            provideCodeActions: async (model, range, context, token) => {
              const target = this.target(model);
              if (!target) return { actions: [], dispose: () => undefined };
              const published = this.diagnostics.get(this.monaco.Uri.parse(target.uri).toString()) ?? [];
              const diagnostics = published.filter((d) => {
                const shown = mapDiagnostic(d, target.back);
                return !!shown && context.markers.some((m) => markerMatches(m, shown));
              });
              const lspRange = toLspRange(range);
              const actions = await this.request<Array<CodeAction | Command> | null>(
                "textDocument/codeAction",
                {
                  textDocument: { uri: target.uri },
                  range: { start: target.out(lspRange.start), end: target.out(lspRange.end) },
                  context: { diagnostics, ...(context.only ? { only: [context.only] } : {}) },
                },
                token,
              );
              const shownOf = (list: Diagnostic[]) =>
                list.flatMap((d) => {
                  const shown = mapDiagnostic(d, target.back);
                  return shown ? [shown] : [];
                });
              return {
                actions: (actions ?? []).map((a) =>
                  toCodeAction(
                    this.monaco,
                    "diagnostics" in a && a.diagnostics ? { ...a, diagnostics: shownOf(a.diagnostics) } : a,
                    shownOf(diagnostics),
                  ),
                ),
                dispose: () => undefined,
              };
            },
          }),
        ];

      case "textDocument/codeLens": {
        const resolve = options.resolveProvider === true;
        const provider: Monaco.languages.CodeLensProvider = {
          onDidChange: this.lensesChanged.event,
          provideCodeLenses: async (model, token) => {
            const target = this.target(model);
            if (!target) return { lenses: [], dispose: () => undefined };
            const lenses = await this.request<CodeLens[] | null>(
              "textDocument/codeLens",
              { textDocument: { uri: target.uri } },
              token,
            );
            return {
              lenses: (lenses ?? []).flatMap((lens) => {
                const range = mapRange(lens.range, target.back);
                if (!range) return [];
                return [
                  {
                    range: toMonacoRange(range),
                    ...(lens.command ? { command: toCommand(lens.command) } : {}),
                    ...(resolve ? { id: JSON.stringify(lens) } : {}),
                  },
                ];
              }),
              dispose: () => undefined,
            };
          },
          ...(resolve
            ? {
                resolveCodeLens: async (model, lens, token) => {
                  const resolved = await this.request<CodeLens>(
                    "codeLens/resolve",
                    JSON.parse(lens.id!) as CodeLens,
                    token,
                  );
                  return resolved?.command ? { ...lens, command: toCommand(resolved.command) } : lens;
                },
              }
            : {}),
        };
        this.lensProvider = provider;
        return [
          languages.registerCodeLensProvider(selector, provider),
          {
            dispose: () => {
              if (this.lensProvider === provider) this.lensProvider = undefined;
            },
          },
        ];
      }

      case "workspace/executeCommand":
        return ((options.commands ?? []) as string[]).map((command) =>
          editor.registerCommand(command, (accessor, ...args: unknown[]) =>
            this.connection
              .sendRequest("workspace/executeCommand", { command, arguments: args })
              .catch((error) => this.options.onMessage(1, `${command} failed: ${errorText(error)}`, true)),
          ),
        );

      default:
        return [];
    }
  }
}

interface Target {
  uri: string;
  out(position: Position): Position;
  back(position: Position): Position | undefined;
}

type MapBack = (position: Position) => Position | undefined;

function mapRange(range: Range, back: MapBack): Range | undefined {
  const start = back(range.start);
  const end = back(range.end);
  return start && end ? { start, end } : undefined;
}

function mapDiagnostic(d: Diagnostic, back: MapBack): Diagnostic | undefined {
  const range = mapRange(d.range, back);
  return range ? { ...d, range } : undefined;
}

/** The item with its edit ranges mapped, or `undefined` when an edit falls
 *  outside. */
function mapCompletionItem(item: CompletionItem, back: MapBack): CompletionItem | undefined {
  const edit = item.textEdit;
  if (!edit) return item;
  if ("range" in edit) {
    const range = mapRange(edit.range, back);
    return range ? { ...item, textEdit: { ...edit, range } } : undefined;
  }
  const insert = mapRange(edit.insert, back);
  const replace = mapRange(edit.replace, back);
  return insert && replace ? { ...item, textEdit: { ...edit, insert, replace } } : undefined;
}

/** Relative semantic tokens re-encoded for a projection: decoded to absolute
 *  positions, each token kept only when it lies wholly inside, re-encoded. */
function mapSemanticTokens(data: number[], back: MapBack): number[] {
  const kept: Array<[number, number, number, number, number]> = [];
  let line = 0;
  let character = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    line += data[i];
    character = data[i] === 0 ? character + data[i + 1] : data[i + 1];
    const start = back({ line, character });
    const end = back({ line, character: character + data[i + 2] });
    if (start && end && start.line === end.line) kept.push([start.line, start.character, data[i + 2], data[i + 3], data[i + 4]]);
  }
  kept.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: number[] = [];
  let lastLine = 0;
  let lastCharacter = 0;
  for (const [l, c, length, type, modifiers] of kept) {
    out.push(l - lastLine, l === lastLine ? c - lastCharacter : c, length, type, modifiers);
    lastLine = l;
    lastCharacter = c;
  }
  return out;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
