/** Matches LSP DiagnosticSeverity values exactly.
 *  https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#diagnosticSeverity */
export const DiagnosticSeverity = {
  Error: 1,
  Warning: 2,
  Information: 3,
  Hint: 4,
} as const;
export type DiagnosticSeverity = (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity];

/** Default entry-point filename when a directory is given instead of a file. */
export const DEFAULT_MANIFEST_FILENAME = "telo.yaml";

export interface Position {
  /** 0-based line number */
  line: number;
  /** 0-based character offset */
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

/** Maps a dotted field path (e.g. "config.handler", "kind") to its source Range.
 *  Built from the YAML AST before conversion to plain objects, so positions reflect
 *  the actual text locations in the source file. */
export type PositionIndex = Map<string, Range>;

/** LSP-compatible Diagnostic shape. range is optional because parsed YAML may not carry
 *  position info when only the parsed object (not raw text) is available. */
export interface AnalysisDiagnostic {
  range?: Range;
  severity?: DiagnosticSeverity;
  code?: string | number;
  /** e.g. "telo-analyzer" */
  source?: string;
  message: string;
  /** Telo-specific extras such as { resource: { kind, name }, path } */
  data?: unknown;
}

export interface ManifestAdapter {
  supports(url: string): boolean;
  read(url: string): Promise<{ text: string; source: string }>;
  resolveRelative(base: string, relative: string): string;
}

export interface LoadOptions {
  /** When true, each YAML document is passed through the CEL precompiler before being
   *  returned. All `${{ expr }}` template strings are replaced with `CompiledValue` wrappers
   *  so the kernel can evaluate them at runtime. Leave unset (false) for static analysis —
   *  the analyzer works on raw strings and does not need compiled values. */
  compile?: boolean;
}

export interface LoaderInitOptions {
  /** Adapters inserted with highest priority before built-ins. */
  extraAdapters?: ManifestAdapter[];
  /** Include built-in HttpAdapter. Defaults to true. */
  includeHttpAdapter?: boolean;
  /** Include built-in RegistryAdapter. Defaults to true. */
  includeRegistryAdapter?: boolean;
  /** Base URL used by built-in RegistryAdapter when enabled. */
  registryUrl?: string;
}

export interface AnalysisOptions {
  strictContexts?: boolean;
}

/** Pre-seeded state for incremental analysis. Passed to StaticAnalyzer.analyze() so it does
 *  not rebuild from scratch on every call. The provided instances are mutated — new definitions
 *  and aliases found in the analysed manifests are registered into them. A single context can
 *  be reused across successive analyze() calls and accumulates state over time, which is the
 *  intended pattern for browser editors (persistent state across edits) and the kernel (live
 *  registry updated as resources are registered at runtime). */
export interface AnalysisContext {
  aliases?: import("./alias-resolver.js").AliasResolver;
  definitions?: import("./definition-registry.js").DefinitionRegistry;
}
