import type { LoadedFile, LoadedGraph } from "@telorun/analyzer";
import {
  AnalysisRegistry,
  Loader,
  StaticAnalyzer,
  flattenForAnalyzer,
} from "@telorun/analyzer";
import { defaultTransportRegistry } from "@telorun/kernel/transports";
import {
  assembleGraphDiagnostics,
  findPositions,
  normalizeDiagnostic,
  renderFixReplacement,
  type NormalizedDiagnostic,
  DiagnosticSeverity,
} from "@telorun/ide-support";
import { NodeAdapter } from "./node-adapter.js";
import * as path from "path";
import * as vscode from "vscode";
import { TeloAnalysisCache } from "./analysis-cache.js";
import { TeloCompletionProvider } from "./completion.js";
import { TeloDefinitionProvider } from "./definition.js";
import { TeloHoverProvider } from "./hover.js";
import { TeloRenameProvider } from "./rename.js";
import {
  REFRESH_IMPORT_UPGRADES_COMMAND,
  TeloImportUpgradeLensProvider,
  UPGRADE_ALL_IMPORTS_COMMAND,
  UPGRADE_IMPORT_COMMAND,
} from "./import-upgrade-lens.js";
import { TeloSemanticTokensProvider, TELO_SEMANTIC_LEGEND } from "./semantic-tokens.js";

const TELO_KIND_RE = /^kind:\s+Telo\./m;
// Broader signature for the language-promote check: any line declaring a
// module-prefixed PascalCase kind (e.g. `Run.Sequence`, `Http.Server`,
// `JS.Script`). Catches partial files included via `Telo.Application.include`
// — those don't carry `kind: Telo.*` themselves but are still Telo manifests.
// Single-word kinds like `Pod`/`Service` (Kubernetes) and lowercased
// `kustomize.config.k8s.io/...` style strings don't match.
const TELO_PARTIAL_KIND_RE = /^kind:\s+[A-Z]\w*\.\w+/m;

const SEVERITY: Record<number, vscode.DiagnosticSeverity> = {
  [DiagnosticSeverity.Error]: vscode.DiagnosticSeverity.Error,
  [DiagnosticSeverity.Warning]: vscode.DiagnosticSeverity.Warning,
  [DiagnosticSeverity.Information]: vscode.DiagnosticSeverity.Information,
  [DiagnosticSeverity.Hint]: vscode.DiagnosticSeverity.Hint,
};

/** A `vscode.Diagnostic` carrying the repair the analyzer computed for it.
 *
 *  `vscode.Diagnostic` has no field for a suggested edit, so the fix rides on
 *  the instance. `CodeActionContext.diagnostics` hands back the very objects
 *  published into the collection — the provider runs in this process, against
 *  this extension host's objects — so the property survives the round trip.
 *  Keeping it here rather than in a side map keyed by position means nothing
 *  has to stay in sync with re-analysis: when the diagnostic is replaced, its
 *  fix goes with it. */
interface DiagnosticWithFix extends vscode.Diagnostic {
  teloFix?: { replacement: string };
}

function toVscodeDiagnostic(n: NormalizedDiagnostic): DiagnosticWithFix {
  const diag: DiagnosticWithFix = new vscode.Diagnostic(
    new vscode.Range(
      n.range.start.line,
      n.range.start.character,
      n.range.end.line,
      n.range.end.character,
    ),
    n.message,
    SEVERITY[n.severity],
  );
  diag.source = n.source;
  if (n.code) diag.code = n.code;
  const replace = n.suggestions?.find((s) => s.kind === "replace");
  if (replace) diag.teloFix = { replacement: replace.replacement };
  return diag;
}

/** Offers the analyzer's repair as a quick fix.
 *
 *  The edit is a whole-value replacement: the diagnostic's range is the value
 *  node's span (that is what `resolveRange` resolves for a stamped `path`), and
 *  `replacement` is the corrected value in full. Re-quoting is delegated to
 *  `renderFixReplacement` so this and the Tauri editor write a repaired scalar
 *  identically — the span includes the author's quotes but not the YAML tag,
 *  so a bare replacement would silently unquote the value. */
class TeloQuickFixProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics as DiagnosticWithFix[]) {
      const fix = diagnostic.teloFix;
      if (!fix) continue;

      // No action when the span cannot be rewritten safely (a block scalar,
      // whose span carries its indicator and its trailing newline). Offering a
      // lightbulb that breaks the document is worse than offering none.
      const replacement = renderFixReplacement(
        document.getText(diagnostic.range),
        fix.replacement,
      );
      if (replacement === undefined) continue;
      const action = new vscode.CodeAction(
        `Replace with ${singleLine(replacement)}`,
        vscode.CodeActionKind.QuickFix,
      );
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(document.uri, diagnostic.range, replacement);
      action.diagnostics = [diagnostic];
      // The analyzer only stamps a repair it can decide, so there is never a
      // second candidate competing for the same diagnostic.
      action.isPreferred = true;
      actions.push(action);
    }
    return actions;
  }
}

/** Action titles sit on one line in the lightbulb menu; a multi-line CEL
 *  replacement would otherwise render with its newlines swallowed. */
function singleLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number): (...args: T) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection("telo");
  context.subscriptions.push(collection);

  // Maps an included/partial file path → set of entry file paths that include it.
  const includeMap = new Map<string, Set<string>>();
  // Maps an owner telo.yaml → set of partial file paths loaded from it.
  const ownerToPartials = new Map<string, Set<string>>();
  // Tracks which source files had diagnostics published (for cleanup on re-analysis).
  const publishedSources = new Map<string, Set<string>>();

  const analyzer = new StaticAnalyzer();
  const cache = new TeloAnalysisCache();
  const completionProvider = new TeloCompletionProvider(cache);
  const hoverProvider = new TeloHoverProvider(cache);
  const semanticTokensProvider = new TeloSemanticTokensProvider(cache);
  const definitionProvider = new TeloDefinitionProvider(cache);
  const renameProvider = new TeloRenameProvider(cache);
  // Background failures that no squiggle can carry — a hub the editor could not
  // reach while checking import versions. `console` is not a channel an author
  // ever opens; this one is reachable from the failure notification.
  const output = vscode.window.createOutputChannel("Telo");
  context.subscriptions.push(output);
  const importUpgradeProvider = new TeloImportUpgradeLensProvider(cache, output);

  const teloSelector: vscode.DocumentSelector = [{ language: "telo" }, { language: "yaml" }];

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      teloSelector,
      completionProvider,
      " ", ":", "/", "@",
    ),
    vscode.languages.registerHoverProvider(teloSelector, hoverProvider),
    vscode.languages.registerDocumentSemanticTokensProvider(
      teloSelector,
      semanticTokensProvider,
      TELO_SEMANTIC_LEGEND,
    ),
    vscode.languages.registerDefinitionProvider(teloSelector, definitionProvider),
    vscode.languages.registerRenameProvider(teloSelector, renameProvider),
    vscode.languages.registerCodeActionsProvider(teloSelector, new TeloQuickFixProvider(), {
      providedCodeActionKinds: TeloQuickFixProvider.providedCodeActionKinds,
    }),
    vscode.languages.registerCodeLensProvider(teloSelector, importUpgradeProvider),
    importUpgradeProvider,
    vscode.commands.registerCommand(UPGRADE_IMPORT_COMMAND, (args) =>
      importUpgradeProvider.apply(args),
    ),
    vscode.commands.registerCommand(UPGRADE_ALL_IMPORTS_COMMAND, (args) =>
      importUpgradeProvider.apply(args),
    ),
    vscode.commands.registerCommand(REFRESH_IMPORT_UPGRADES_COMMAND, () =>
      importUpgradeProvider.refresh(),
    ),
    // The hub URL decides what the version lookups answer, and the enable flag
    // decides whether they run at all — either moving invalidates the cache.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("telo.hubUrl") || e.affectsConfiguration("telo.importUpgrades")) {
        importUpgradeProvider.refresh();
      }
    }),
  );

  // Promote a yaml document to the `telo` language id when its content looks
  // like a Telo manifest. Disables Red Hat's YAML extension for these files
  // (its contributions are scoped to language id `yaml`), which removes false
  // positives like the `!cel` / `!literal` "unresolved tag" warnings. The
  // switch is per-document for the session; on reopen, filename patterns
  // (`telo.yaml`, `*.telo.yaml`) handle the well-known case automatically and
  // this fallback catches any other yaml file declaring `kind: Telo.*`.
  async function maybePromoteToTelo(document: vscode.TextDocument): Promise<vscode.TextDocument> {
    if (document.languageId !== "yaml") return document;
    // Use the broader partial-kind pattern so files included via
    // `Telo.Application.include` (which carry kinds like `Run.Sequence`,
    // not `Telo.*`) also get promoted. The standalone-analysis fallback
    // below still uses the stricter `TELO_KIND_RE` so unrelated YAML
    // doesn't get spurious Telo diagnostics.
    if (!TELO_PARTIAL_KIND_RE.test(document.getText())) return document;
    return await vscode.languages.setTextDocumentLanguage(document, "telo");
  }

  async function analyzeDocument(rawDocument: vscode.TextDocument): Promise<void> {
    const document = await maybePromoteToTelo(rawDocument);
    if (document.languageId !== "telo" && document.languageId !== "yaml") return;

    // Skip files that don't look like Telo manifests (no kind: field).
    // Prevents unrelated YAML (docker-compose, CI configs, etc.) from being
    // treated as Telo partials just because a parent telo.yaml exists.
    if (!/^kind:\s+/m.test(document.getText())) {
      collection.delete(document.uri);
      return;
    }

    const filePath = document.uri.fsPath;
    // Resolve imports origin-direct through the kernel's transport sources —
    // `oci://` included — exactly like `telo check`. The VS Code host is Node,
    // so it speaks OCI directly and never routes through the hub cache.
    const loader = new Loader([
      new NodeAdapter(path.dirname(filePath)),
      ...defaultTransportRegistry().sources(),
    ]);

    let result: Awaited<ReturnType<typeof loader.loadGraphForFile>>;
    try {
      // `desugarImports` so inline `imports:` maps resolve like authored docs in
      // VS Code diagnostics — without it the editor would flag false
      // UNRESOLVED_REFERENCE for `!ref Alias.x` against an inline import.
      result = await loader.loadGraphForFile(filePath, { desugarImports: true, migrate: true });
    } catch (err) {
      collection.set(document.uri, [
        {
          severity: vscode.DiagnosticSeverity.Error,
          range: new vscode.Range((err as any).sourceLine ?? 0, 0, (err as any).sourceLine ?? 0, 0),
          message: err instanceof Error ? err.message : String(err),
          source: "telo-analyzer",
        },
      ]);
      return;
    }

    if (!result) {
      if (!TELO_KIND_RE.test(document.getText())) {
        collection.delete(document.uri);
        return;
      }
      // Fall through to standalone analysis: treat the file as its own owner.
      let standaloneGraph: LoadedGraph;
      try {
        standaloneGraph = await loader.loadGraph(filePath, { desugarImports: true, migrate: true });
      } catch (err) {
        collection.set(document.uri, [
          {
            severity: vscode.DiagnosticSeverity.Error,
            range: new vscode.Range((err as any).sourceLine ?? 0, 0, (err as any).sourceLine ?? 0, 0),
            message: err instanceof Error ? err.message : String(err),
            source: "telo-analyzer",
          },
        ]);
        return;
      }

      for (const mod of standaloneGraph.modules.values()) {
        for (const partial of mod.partials) {
          if (partial.source === filePath) continue;
          let entries = includeMap.get(partial.source);
          if (!entries) {
            entries = new Set();
            includeMap.set(partial.source, entries);
          }
          entries.add(filePath);
        }
      }

      analyzeAndPublish(filePath, filePath, standaloneGraph);
      return;
    }

    const { graph, ownerUrl } = result;
    const ownerModule = graph.modules.get(ownerUrl);
    const partialSources = new Set<string>();
    if (ownerModule) {
      for (const partial of ownerModule.partials) {
        partialSources.add(partial.source);
        let entries = includeMap.get(partial.source);
        if (!entries) {
          entries = new Set();
          includeMap.set(partial.source, entries);
        }
        entries.add(ownerUrl);
      }
    }
    ownerToPartials.set(ownerUrl, partialSources);

    if (filePath !== ownerUrl && !partialSources.has(filePath)) {
      collection.set(document.uri, [
        {
          severity: vscode.DiagnosticSeverity.Warning,
          range: new vscode.Range(0, 0, 0, 0),
          message: `This file is not listed in the 'include' field of ${ownerUrl}. It will not be loaded at runtime.`,
          source: "telo-analyzer",
        },
      ]);
      return;
    }

    analyzeAndPublish(ownerUrl, filePath, graph);
  }

  function analyzeAndPublish(
    ownerFilePath: string,
    entryFilePath: string,
    graph: LoadedGraph,
  ): void {
    const manifests = flattenForAnalyzer(graph);

    const registry = new AnalysisRegistry();
    // The shared assembler (ide-support) folds every diagnostic channel — parse,
    // version-reconciliation, import-resolution, and static analysis — into one
    // list, holding back the cascade for files that failed to parse or whose
    // imports failed to resolve. Sourcing all channels here through the same
    // policy is what keeps the extension showing *exactly* what telo-editor
    // shows (and the CLI): a broken `imports:` source can no longer be silently
    // dropped, and the same compromised-file cascade is suppressed in both. Each
    // diagnostic carries `data.filePath` (+ `path: imports.<alias>` for
    // import/version ones), so the shared `findPositions` resolver below lands it
    // on the right line. `suppressed` is available to render dimmed later.
    const analysisDiagnostics = analyzer.analyze(manifests, undefined, registry);
    const { diagnostics: rawDiagnostics } = assembleGraphDiagnostics(graph, analysisDiagnostics);

    const diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();

    for (const d of rawDiagnostics) {
      const located = findPositions(graph, d.data);
      const sourceFile = located?.file ?? entryFilePath;
      const normalized = normalizeDiagnostic(d, {
        registry,
        positionIndex: located?.positionIndex,
        sourceLine: located?.sourceLine,
      });

      let bucket = diagnosticsByFile.get(sourceFile);
      if (!bucket) {
        bucket = [];
        diagnosticsByFile.set(sourceFile, bucket);
      }
      bucket.push(toVscodeDiagnostic(normalized));
    }

    // Clear diagnostics from files that had them previously but now have none.
    // Keyed by ownerFilePath so all analysis passes for the same module share state.
    const previousSources = publishedSources.get(ownerFilePath);
    if (previousSources) {
      for (const prev of previousSources) {
        if (!diagnosticsByFile.has(prev)) {
          collection.set(vscode.Uri.file(prev), []);
        }
      }
    }

    // Publish diagnostics per source file
    const newSources = new Set<string>();
    for (const [file, diags] of diagnosticsByFile) {
      collection.set(vscode.Uri.file(file), diags);
      newSources.add(file);
    }
    publishedSources.set(ownerFilePath, newSources);

    // If the owner file itself has no diagnostics, clear it
    if (!diagnosticsByFile.has(ownerFilePath)) {
      collection.set(vscode.Uri.file(ownerFilePath), []);
    }

    // Make the populated registry available for completions, plus the entry
    // file's already-parsed AST so completion can skip re-parsing when the
    // buffer is unchanged (guarded by text identity in the provider).
    let entryLoaded: LoadedFile | undefined;
    for (const mod of graph.modules.values()) {
      if (mod.owner.source === entryFilePath) {
        entryLoaded = mod.owner;
        break;
      }
      const partial = mod.partials.find((p) => p.source === entryFilePath);
      if (partial) {
        entryLoaded = partial;
        break;
      }
    }
    cache.set(
      entryFilePath,
      registry,
      graph,
      entryLoaded ? { text: entryLoaded.text, docs: entryLoaded.astDocuments } : undefined,
    );
    // Recolor: a kind that only just resolved (e.g. an import finished loading)
    // should light up without waiting for the next keystroke.
    semanticTokensProvider.refresh();
  }

  async function reanalyzeEntries(changedPath: string): Promise<void> {
    // Cascade to entry files that import this file
    const entries = includeMap.get(changedPath);
    if (entries) {
      for (const entryPath of entries) {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === entryPath);
        if (doc) await analyzeDocument(doc);
      }
    }

    // If this is an owner file, re-analyze all open partial files
    const partials = ownerToPartials.get(changedPath);
    if (partials) {
      for (const partialPath of partials) {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === partialPath);
        if (doc) await analyzeDocument(doc);
      }
    }
  }

  const onChangedDebounced = debounce((e: vscode.TextDocumentChangeEvent) => {
    analyzeDocument(e.document);
    reanalyzeEntries(e.document.uri.fsPath);
  }, 500);

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(analyzeDocument),
    vscode.workspace.onDidChangeTextDocument(onChangedDebounced),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      collection.delete(doc.uri);
      cache.delete(doc.uri.fsPath);
    }),
  );

  for (const doc of vscode.workspace.textDocuments) {
    analyzeDocument(doc);
  }
}

export function deactivate(): void {}
