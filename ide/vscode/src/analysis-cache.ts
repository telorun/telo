import type { AnalysisRegistry, AstDocument, LoadedGraph } from "@telorun/analyzer";

interface CachedAnalysis {
  registry: AnalysisRegistry;
  /** The loaded graph, for cross-file features (go-to-definition). */
  graph?: LoadedGraph;
  /** The entry file's parsed AST plus the text it was parsed from, so language
   *  features skip re-parsing when the buffer is unchanged. */
  parsed?: { text: string; docs: AstDocument[] };
}

/** Per-file analysis output shared by every language feature (completion, hover,
 *  semantic tokens, definition). Populated once per analysis pass in
 *  `extension.ts`; each provider reads the same `AnalysisRegistry` / graph / AST
 *  rather than keeping its own. */
export class TeloAnalysisCache {
  private readonly byFile = new Map<string, CachedAnalysis>();

  set(
    filePath: string,
    registry: AnalysisRegistry,
    graph?: LoadedGraph,
    parsed?: { text: string; docs: AstDocument[] },
  ): void {
    this.byFile.set(filePath, { registry, graph, parsed });
  }

  registryFor(filePath: string): AnalysisRegistry | undefined {
    return this.byFile.get(filePath)?.registry;
  }

  graphFor(filePath: string): LoadedGraph | undefined {
    return this.byFile.get(filePath)?.graph;
  }

  /** The cached AST when it still matches `text`, else undefined so the caller
   *  falls back to a local parse. */
  docsFor(filePath: string, text: string): AstDocument[] | undefined {
    const cached = this.byFile.get(filePath)?.parsed;
    return cached && cached.text === text ? cached.docs : undefined;
  }

  delete(filePath: string): void {
    this.byFile.delete(filePath);
  }
}
