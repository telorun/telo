import * as path from "path";
import * as vscode from "vscode";
import {
  DiagnosticSeverity,
  StaticAnalyzer,
  NodeAdapter,
  Loader,
} from "@telorun/analyzer";
import type { AnalysisDiagnostic } from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";

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

function debounce<T extends unknown[]>(
  fn: (...args: T) => void,
  ms: number,
): (...args: T) => void {
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

  async function analyzeDocument(document: vscode.TextDocument): Promise<void> {
    if (document.languageId !== "yaml") return;
    if (!TELO_KIND_RE.test(document.getText())) {
      collection.delete(document.uri);
      return;
    }

    const filePath = document.uri.fsPath;
    const loader = new Loader([new NodeAdapter(path.dirname(filePath))]);

    let manifests: ResourceManifest[];
    try {
      manifests = await loader.loadManifests(filePath);
    } catch {
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

    const manifestByKey = new Map<string, ResourceManifest>();
    for (const m of manifests) {
      if (m.kind && m.metadata?.name) {
        manifestByKey.set(`${m.kind}.${m.metadata.name}`, m);
      }
    }

    const diagnostics = analyzer.analyze(manifests).map((d) => {
      const resource = (d.data as any)?.resource as
        | { kind: string; name: string }
        | undefined;
      const m = resource
        ? manifestByKey.get(`${resource.kind}.${resource.name}`)
        : undefined;
      const sourceLine = (m?.metadata as any)?.sourceLine as number | undefined;
      if (sourceLine !== undefined && !d.range) {
        return toDiagnostic({
          ...d,
          range: {
            start: { line: sourceLine, character: 0 },
            end: { line: sourceLine, character: Number.MAX_SAFE_INTEGER },
          },
        });
      }
      return toDiagnostic(d);
    });
    collection.set(document.uri, diagnostics);
  }

  async function reanalyzeEntries(changedPath: string): Promise<void> {
    const entries = includeMap.get(changedPath);
    if (!entries) return;
    for (const entryPath of entries) {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === entryPath,
      );
      if (doc) await analyzeDocument(doc);
    }
  }

  const onChangedDebounced = debounce(
    (e: vscode.TextDocumentChangeEvent) => {
      analyzeDocument(e.document);
      reanalyzeEntries(e.document.uri.fsPath);
    },
    500,
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(analyzeDocument),
    vscode.workspace.onDidChangeTextDocument(onChangedDebounced),
    vscode.workspace.onDidCloseTextDocument((doc) =>
      collection.delete(doc.uri),
    ),
  );

  for (const doc of vscode.workspace.textDocuments) {
    analyzeDocument(doc);
  }
}

export function deactivate(): void {}
