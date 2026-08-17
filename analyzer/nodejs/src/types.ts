import type { HostVersions } from "./requires-block.js";

import type { ZoneModuleDocuments } from "./zone-module-documents.js";
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
/** A mechanically applicable repair, carried unchanged from whatever produced
 *  it (a templating engine, a kind-name suggestion) to every consumer: CLI
 *  JSON, IDE CodeActions, an agent applying it without re-deriving it from
 *  prose.
 *
 *  `replacement` is the **whole** value at the diagnostic's `path`, corrected —
 *  never a fragment — so applying it needs no knowledge of the language inside.
 *  There is deliberately no sub-range: carrying one beside a whole-value
 *  replacement gives the field two readings, and the minimal-edit reading
 *  (splice `replacement` at `range`) produces garbage because the two measure
 *  different strings.
 *
 *  One shape rather than one per producer: a `fix` field beside a
 *  `suggestedKind` field beside a CEL-specific one would leave every host
 *  wiring a separate action path for what is the same gesture. */
export interface DiagnosticFix {
  readonly replacement: string;
}

/** The `data` stamp diagnostics carry. Loose by design — passes bolt their own
 *  keys on — but the fields every consumer reads are declared. */
export interface DiagnosticData {
  resource?: { kind: string; name: string };
  filePath?: string;
  /** Dotted path of the offending value within its resource. */
  path?: string;
  fix?: DiagnosticFix;
  [key: string]: unknown;
}

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

/** Single reader for a diagnostic's fix, so no consumer re-derives the shape
 *  by hand-casting `data`. */
export function diagnosticFix(d: AnalysisDiagnostic): DiagnosticFix | undefined {
  const fix = (d.data as DiagnosticData | undefined)?.fix;
  return fix && typeof fix.replacement === "string" ? fix : undefined;
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
  /** When true, the loader's migration phase rewrites legacy spellings in each
   *  parsed document before anything else reads the tree. On for every resolved
   *  consumer — the kernel's analysis and runtime loads, `telo check`, the
   *  analyzer — so one rewrite serves the definition registry, the runtime and
   *  the editor's analysis alike.
   *
   *  **Off for a round-trip view.** The editor pairs manifests to YAML nodes by
   *  index and writes the pair back on save; migrating one half of that pair
   *  would silently change the author's file. `telo migrate` is likewise a raw
   *  consumer — it rewrites the YAML itself and must see the legacy spelling to
   *  find it. Folded into the file cache key so a migrated and a raw load of
   *  the same file never collide. */
  migrate?: boolean;
}

export interface LoaderInitOptions {
  /** Handlers for CEL stdlib functions (e.g. `sha256`). Analyzer-only callers may
   *  omit this and get throwing stubs; runtime callers (kernel) must supply real impls. */
  celHandlers?: import("./cel-environment.js").CelHandlers;
  /** Migration set for `LoadOptions.migrate` loads. Defaults to the analyzer's
   *  own `CORE_MIGRATIONS`. A host supplies its own once module-shipped entries
   *  are aggregated alongside the core ones. */
  migrations?: readonly import("./migrations/types.js").MigrationEntry[];
}

export interface AnalysisOptions {
  strictContexts?: boolean;
  /** Imported libraries' FULL document sets, for the zone stage's per-library
   *  export derivation — the flattened analysis view forwards only each
   *  library's export surface, never its internal dispatch chain. Collected
   *  from a LoadedGraph via `collectZoneModuleDocuments`. Omitting it skips
   *  the derivation (the under-approximating direction — the runtime check
   *  remains the enforcement). */
  moduleDocuments?: ZoneModuleDocuments[];
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
  /** The manifest SURFACE GENERATION the runtime performing this analysis
   *  implements, against which every module's `requires.telo` range is checked.
   *
   *  Defaults to this build's own (`TELO_SURFACE_VERSION`), which is the right
   *  answer for the kernel, the CLI and the editor alike. In a browser no kernel
   *  is running, so the only well-posed question is whether the runtime *doing
   *  the analysis* can read the module — and that is exactly the case where the
   *  diagnostic is needed, since an editor too old to parse a construct
   *  otherwise produces vocabulary errors it cannot explain.
   *
   *  The kernel deliberately does NOT override with its own package version.
   *  The constant is generated from the linked kernel version, so the two are
   *  the same number by construction; where they can drift — a kernel resolving
   *  an older analyzer than it was released with — the analyzer is the half that
   *  PARSES, and claiming a generation higher than the bundled parser implements
   *  would be a claim the stack cannot honour.
   *
   *  So this exists for checking against a DIFFERENT target than oneself: a CI
   *  matrix, or an editor setting naming the version a team deploys on.
   *
   *  Defaulted rather than optional-and-silent on purpose: there is no "caller
   *  forgot to pass it, check silently skipped" path. */
  teloVersion?: string;
  /** Versions of the HOST the analysis is being performed for, against which a
   *  module's `requires.host.*` ranges are checked.
   *
   *  Absent in a browser, where there is no host to speak for, and an axis with
   *  no supplied version is skipped rather than guessed. The kernel and the CLI
   *  supply it because they are the host. */
  hostVersions?: HostVersions;
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
