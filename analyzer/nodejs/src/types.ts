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

export interface ManifestSource {
  supports(url: string): boolean;
  read(url: string): Promise<{ text: string; source: string }>;
  resolveRelative(base: string, relative: string): string;

  /** Expand glob patterns relative to a base source. Returns sources in the same
   *  format as read().source — suitable to pass back into read() / resolveRelative().
   *  Optional — only filesystem-capable sources implement this. */
  expandGlob?(base: string, patterns: string[]): Promise<string[]>;

  /** Walk parent directories from fileUrl looking for the nearest telo.yaml.
   *  Returns the source in the same format as read().source, or null if none found.
   *  Optional — only filesystem-capable sources implement this. */
  resolveOwnerOf?(fileUrl: string): Promise<string | null>;
}

export interface LoadOptions {
  /** When true, each YAML document is passed through the CEL precompiler before being
   *  returned. All `${{ expr }}` template strings are replaced with `CompiledValue` wrappers
   *  so the kernel can evaluate them at runtime. Leave unset (false) for static analysis —
   *  the analyzer works on raw strings and does not need compiled values. */
  compile?: boolean;
  /** When true, each module document's inline `imports:` map is desugared into
   *  synthetic `Telo.Import` manifests appended to the file's `manifests` /
   *  `positions` (the AST `documents` array is left raw). On for every resolved
   *  consumer — the kernel's analysis and runtime loads, and the analyzer — so
   *  inline imports participate in discovery, alias resolution, and execution.
   *  Off for the editor's round-trip view, which reads the raw `imports:` map and
   *  pairs manifests to YAML nodes by index. Folded into the file cache key so a
   *  desugared and a raw load of the same file never collide. */
  desugarImports?: boolean;
}

export interface LoaderInitOptions {
  /** Sources inserted with highest priority before built-ins. */
  extraSources?: ManifestSource[];
  /** Include built-in HttpSource. Defaults to true. */
  includeHttpSource?: boolean;
  /** Include built-in RegistrySource. Defaults to true. */
  includeRegistrySource?: boolean;
  /** Base URL used by built-in RegistrySource when enabled. */
  registryUrl?: string;
  /** Handlers for CEL stdlib functions (e.g. `sha256`). Analyzer-only callers may
   *  omit this and get throwing stubs; runtime callers (kernel) must supply real impls. */
  celHandlers?: import("./cel-environment.js").CelHandlers;
}

export interface AnalysisOptions {
  strictContexts?: boolean;
  /** When true, `analyze()` runs the state-mutating setup (module identity /
   *  alias / definition registration plus `normalizeInlineResources`) but
   *  skips every diagnostic-producing pass — per-resource validation, the
   *  Library `env:` check, `validateExtends`, `validateProviderCoherence`,
   *  and `validateThrowsCoverage`. Used by the kernel when a previous load
   *  has already stamped the manifest set as valid (by content hash), so
   *  the registry still gets populated without paying the validation walk
   *  on every cold start. The caller takes responsibility for the
   *  correctness guarantee — pass this only when something durable
   *  (on-disk stamp) attests that the manifests passed a real analyze
   *  pass at the same analyzer / kernel version. */
  skipValidation?: boolean;
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
  /** Per-library alias resolvers keyed by the library's module name. Populated by
   *  the analyzer when imports are forwarded from inside imported libraries.
   *  Validators that resolve schema-side annotations (e.g. x-telo-schema-from
   *  pointing at an imported kind) consult the kind owner's scope here, since
   *  the consumer's aliases will not contain a library's private imports. */
  aliasesByModule?: Map<string, import("./alias-resolver.js").AliasResolver>;
}
