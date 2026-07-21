import type { ResourceManifest } from "@telorun/sdk";
import type { Document } from "yaml";
import type { DocumentPosition } from "./position-metadata.js";
import type { AnalysisDiagnostic, Range } from "./types.js";

/** One physical file's parsed result. Returned for the owner manifest, for
 *  each `include:` partial, and for each external import target.
 *
 *  Identity rule: every map key, every cross-reference, every editor-side
 *  cache uses `source` — the URL the source adapter's `read()` returned. */
export interface LoadedFile {
  /** Canonical identity. The URL the source adapter's `read()` returned —
   *  HTTPS for http/registry, an absolute path for local. */
  source: string;
  /** The URL the caller supplied (e.g. registry ref `std/javascript@0.3.0`).
   *  Differs from `source` only for adapter-resolved URLs. */
  requestedUrl: string;
  /** Raw text exactly as `read()` returned it. */
  text: string;
  /** Per-document parsed AST, in source order. */
  documents: Document[];
  /** Per-document JSON projection (`doc.toJSON()`). Aligned to `documents`. */
  manifests: Array<ResourceManifest | null>;
  /** Per-document `{sourceLine, positionIndex}`. Aligned to `documents`. */
  positions: DocumentPosition[];
  /** Document-level parse errors aggregated from `yaml.Document.errors`. */
  parseErrors: ParseError[];
}

export interface ParseError {
  documentIndex: number;
  message: string;
  /** Line/character of the failure, when the yaml parser provided one. */
  range?: Range;
}

/** An owner file plus the partial files it includes. The unit
 *  `Loader.loadModule` returns. */
export interface LoadedModule {
  owner: LoadedFile;
  /** Each `include:` target as its own LoadedFile. Empty when no `include:`.
   *  Order matches the `include:` list (after glob expansion). */
  partials: LoadedFile[];
}

/** Resolved Telo.Import edge: where the import points and what library
 *  identity it resolves to. Carrying name/namespace on the edge means
 *  `flattenForAnalyzer` can stamp `metadata.resolvedModuleName` /
 *  `resolvedNamespace` from this single source rather than re-deriving
 *  the target from manifest metadata, which would silently miss whenever
 *  a future projection forgets to stamp `metadata.source` consistently. */
export interface ImportEdge {
  /** Canonical resolved URL of the target — a key into `modules`. */
  targetSource: string;
  /** Target library's `metadata.name`, or `null` when the target had no
   *  Telo.Library doc (an error case captured in `LoadedGraph.errors`). */
  targetModuleName: string | null;
  /** Target library's `metadata.namespace` (or `null` when unset). */
  targetNamespace: string | null;
}

/** An entry plus every transitively-imported library. Returned by
 *  `Loader.loadGraph`. */
export interface LoadedGraph {
  /** Canonical entry source — equals `entry.owner.source`. */
  rootSource: string;
  entry: LoadedModule;
  /** Map keyed by `LoadedFile.source` (canonical resolved URL). Includes
   *  entry, partials, and every transitively reachable Telo.Import target +
   *  its partials. */
  modules: Map<string, LoadedModule>;
  /** Per-Telo.Import resolution. Keyed by the resolved URL of the file the
   *  Telo.Import was declared in, then by the import's PascalCase alias.
   *  Version reconciliation repoints losing edges at their winner here, so a
   *  consumer walking these edges (`flattenForAnalyzer`) sees one version per
   *  module identity. */
  importEdges: Map<string, Map<string, ImportEdge>>;
  /** Version-reconciliation redirects: a losing module's canonical source URL →
   *  the winning version's canonical source URL. The runtime consults this when
   *  it independently re-resolves an import (the analyzer already sees repointed
   *  `importEdges`). Empty when no module identity appeared at two sources. */
  overrides: Map<string, string>;
  /** Diagnostics produced while reconciling module versions — one per import
   *  edge redirected to a different version (warning for a same-major hoist,
   *  error for a major mismatch). Surfaced alongside `analyze()` diagnostics by
   *  every consumer (CLI, editor, VS Code). */
  versionDiagnostics: AnalysisDiagnostic[];
  /** YAML parse failures aggregated from every file's `parseErrors`. A file
   *  that fails to parse yields a mangled `toJSON()` projection, so these are
   *  fatal Error diagnostics — surfaced alongside `analyze()` output by every
   *  consumer (CLI, editor, VS Code) and treated as fatal by the kernel. */
  parseDiagnostics: AnalysisDiagnostic[];
  /** Surface-level errors that did not abort the graph load (e.g. an import
   *  whose target failed to fetch). */
  errors: GraphLoadError[];
}

export interface GraphLoadError {
  /** URL of the file that failed to load (resolved — may be a `file://` URL for
   *  a relative import). */
  url: string;
  /** The import source string exactly as authored (`./lib`, `std/x@1.0.0`),
   *  before relative-path resolution. Preferred over `url` for classification
   *  and display, so a diagnostic quotes what the author wrote. */
  source?: string;
  /** Source of the import that triggered the load, or null for the entry. */
  fromSource: string | null;
  /** Import alias the failed source was bound to in `fromSource`'s `imports:`
   *  map, when the failure is a transitive import (absent for an entry-load
   *  failure). Lets a consumer anchor the diagnostic at `imports.<alias>`. */
  alias?: string;
  /** Line of the `Telo.Import` doc in `fromSource`, for position fallback. */
  sourceLine?: number;
  error: Error;
}
