import type { AnalysisDiagnostic, PositionIndex } from "@telorun/analyzer";
import { AnalysisRegistry, DiagnosticSeverity, Loader, NodeAdapter, StaticAnalyzer } from "@telorun/analyzer";
import * as path from "path";
import * as vscode from "vscode";
import { TeloCompletionProvider } from "./completion.js";

const TELO_KIND_RE = /^kind:\s+Kernel\./m;

const SEVERITY: Record<number, vscode.DiagnosticSeverity> = {
  [DiagnosticSeverity.Error]: vscode.DiagnosticSeverity.Error,
  [DiagnosticSeverity.Warning]: vscode.DiagnosticSeverity.Warning,
  [DiagnosticSeverity.Information]: vscode.DiagnosticSeverity.Information,
  [DiagnosticSeverity.Hint]: vscode.DiagnosticSeverity.Hint,
};

function toDiagnostic(d: AnalysisDiagnostic): vscode.Diagnostic {
  const range = d.range
    ? new vscode.Range(
        d.range.start.line,
        d.range.start.character,
        d.range.end.line,
        d.range.end.character,
      )
    : new vscode.Range(0, 0, 0, 0);
  const diag = new vscode.Diagnostic(
    range,
    d.message,
    SEVERITY[d.severity ?? DiagnosticSeverity.Warning],
  );
  diag.source = d.source ?? "telo";
  if (d.code !== undefined) diag.code = String(d.code);
  return diag;
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

  // Maps an included file path → set of entry file paths that include it.
  const includeMap = new Map<string, Set<string>>();

  const analyzer = new StaticAnalyzer();
  const completionProvider = new TeloCompletionProvider();

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: "yaml" },
      completionProvider,
      " ", ":",
    ),
  );

  async function analyzeDocument(document: vscode.TextDocument): Promise<void> {
    if (document.languageId !== "yaml") return;
    if (!TELO_KIND_RE.test(document.getText())) {
      collection.delete(document.uri);
      return;
    }

    const filePath = document.uri.fsPath;
    const loader = new Loader([new NodeAdapter(path.dirname(filePath))]);

    let manifests: Awaited<ReturnType<typeof loader.loadManifests>>;
    try {
      manifests = await loader.loadManifests(filePath);
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

    // Update include-graph: map each included source back to this entry file.
    for (const m of manifests) {
      const src = m.metadata?.source as string | undefined;
      if (!src || src === filePath) continue;
      let entries = includeMap.get(src);
      if (!entries) {
        entries = new Set();
        includeMap.set(src, entries);
      }
      entries.add(filePath);
    }

    const manifestByKey = new Map<string, (typeof manifests)[number]>();
    for (const m of manifests) {
      if (m.kind && m.metadata?.name) {
        manifestByKey.set(`${m.kind}.${m.metadata.name}`, m);
      }
    }

    // Fresh registry per analysis pass so stale imports don't linger.
    const registry = new AnalysisRegistry();
    const diagnostics = analyzer.analyze(manifests, undefined, registry).map((d) => {
      const resource = (d.data as any)?.resource as { kind: string; name: string } | undefined;
      const m = resource ? manifestByKey.get(`${resource.kind}.${resource.name}`) : undefined;
      const sourceLine = (m?.metadata as any)?.sourceLine as number | undefined;
      const positionIndex = (m?.metadata as any)?.positionIndex as PositionIndex | undefined;
      const path = (d.data as any)?.path as string | undefined;

      if (!d.range) {
        const fieldRange =
          path !== undefined && positionIndex ? positionIndex.get(path) : undefined;
        if (fieldRange) {
          return toDiagnostic({ ...d, range: fieldRange });
        } else if (sourceLine !== undefined) {
          return toDiagnostic({
            ...d,
            range: {
              start: { line: sourceLine, character: 0 },
              end: { line: sourceLine, character: Number.MAX_SAFE_INTEGER },
            },
          });
        }
      }
      return toDiagnostic(d);
    });
    collection.set(document.uri, diagnostics);

    // Make the populated registry available for completions.
    completionProvider.updateRegistry(filePath, registry);
  }

  async function reanalyzeEntries(changedPath: string): Promise<void> {
    const entries = includeMap.get(changedPath);
    if (!entries) return;
    for (const entryPath of entries) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === entryPath);
      if (doc) await analyzeDocument(doc);
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
      completionProvider.deleteRegistry(doc.uri.fsPath);
    }),
  );

  for (const doc of vscode.workspace.textDocuments) {
    analyzeDocument(doc);
  }
}

export function deactivate(): void {}
