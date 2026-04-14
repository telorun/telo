import type { AnalysisDiagnostic, PositionIndex } from "@telorun/analyzer";
import { AnalysisRegistry, DiagnosticSeverity, Loader, StaticAnalyzer } from "@telorun/analyzer";
import { NodeAdapter } from "./node-adapter.js";
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

  // Maps an included/partial file path → set of entry file paths that include it.
  const includeMap = new Map<string, Set<string>>();
  // Maps an owner telo.yaml → set of partial file paths loaded from it.
  const ownerToPartials = new Map<string, Set<string>>();
  // Tracks which source files had diagnostics published (for cleanup on re-analysis).
  const publishedSources = new Map<string, Set<string>>();

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

    // Skip files that don't look like Telo manifests (no kind: field).
    // Prevents unrelated YAML (docker-compose, CI configs, etc.) from being
    // treated as Telo partials just because a parent telo.yaml exists.
    if (!/^kind:\s+/m.test(document.getText())) {
      collection.delete(document.uri);
      return;
    }

    const filePath = document.uri.fsPath;
    const loader = new Loader([new NodeAdapter(path.dirname(filePath))]);

    // Try loading as a module-aware file (owner or partial)
    let moduleResult: Awaited<ReturnType<typeof loader.loadModuleForFile>>;
    try {
      moduleResult = await loader.loadModuleForFile(filePath);
    } catch (err) {
      // Surface load errors (e.g. owner parse failures, system-kind violations) as diagnostics
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

    // If loadModuleForFile didn't find an owner, fall back to the original heuristic
    if (!moduleResult) {
      if (!TELO_KIND_RE.test(document.getText())) {
        collection.delete(document.uri);
        return;
      }
      // Fall through to standalone analysis
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

      analyzeAndPublish(filePath, filePath, manifests, loader);
      return;
    }

    // Module-aware path: we have owner context
    const { ownerUrl, manifests, sourceManifests } = moduleResult;

    // Update owner ↔ partial tracking
    const partials = new Set<string>();
    for (const src of sourceManifests.keys()) {
      if (src !== ownerUrl) {
        partials.add(src);
        // Map partial → owner for cascading
        let entries = includeMap.get(src);
        if (!entries) {
          entries = new Set();
          includeMap.set(src, entries);
        }
        entries.add(ownerUrl);
      }
    }
    ownerToPartials.set(ownerUrl, partials);

    // Check if this partial file is not listed in the owner's include
    if (!sourceManifests.has(filePath) && filePath !== ownerUrl) {
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

    analyzeAndPublish(ownerUrl, filePath, manifests, loader);
  }

  function analyzeAndPublish(
    ownerFilePath: string,
    entryFilePath: string,
    manifests: Awaited<ReturnType<typeof Loader.prototype.loadManifests>>,
    loader: Loader,
  ): void {
    const manifestByKey = new Map<string, (typeof manifests)[number]>();
    for (const m of manifests) {
      if (m.kind && m.metadata?.name) {
        manifestByKey.set(`${m.kind}.${m.metadata.name}`, m);
      }
    }

    // Fresh registry per analysis pass so stale imports don't linger.
    const registry = new AnalysisRegistry();
    const rawDiagnostics = analyzer.analyze(manifests, undefined, registry);

    // Bucket diagnostics by source file for per-file routing
    const diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();

    for (const d of rawDiagnostics) {
      const resource = (d.data as any)?.resource as { kind: string; name: string } | undefined;
      const m = resource ? manifestByKey.get(`${resource.kind}.${resource.name}`) : undefined;
      const sourceFile = (m?.metadata as any)?.source as string | undefined;
      const sourceLine = (m?.metadata as any)?.sourceLine as number | undefined;
      const positionIndex = (m?.metadata as any)?.positionIndex as PositionIndex | undefined;
      const fieldPath = (d.data as any)?.path as string | undefined;

      // Resolve the target file for this diagnostic
      const targetFile = sourceFile ?? entryFilePath;

      // Resolve position within the target file
      let resolved: AnalysisDiagnostic = d;
      if (!d.range) {
        const fieldRange =
          fieldPath !== undefined && positionIndex ? positionIndex.get(fieldPath) : undefined;
        if (fieldRange) {
          resolved = { ...d, range: fieldRange };
        } else if (sourceLine !== undefined) {
          resolved = {
            ...d,
            range: {
              start: { line: sourceLine, character: 0 },
              end: { line: sourceLine, character: Number.MAX_SAFE_INTEGER },
            },
          };
        }
      }

      let bucket = diagnosticsByFile.get(targetFile);
      if (!bucket) {
        bucket = [];
        diagnosticsByFile.set(targetFile, bucket);
      }
      bucket.push(toDiagnostic(resolved));
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

    // Make the populated registry available for completions.
    completionProvider.updateRegistry(entryFilePath, registry);
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
      completionProvider.deleteRegistry(doc.uri.fsPath);
    }),
  );

  for (const doc of vscode.workspace.textDocuments) {
    analyzeDocument(doc);
  }
}

export function deactivate(): void {}
