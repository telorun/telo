import type { ResourceManifest } from "@telorun/sdk";
import type { CelProgramSite } from "@telorun/templating";
import type { Document } from "yaml";
import type { LibraryMigrationOutcome } from "./library-migrations/stage.js";
import type { FileMigrations } from "./migrations/driver.js";
import type { DocumentPosition } from "./position-metadata.js";
import type { AnalysisDiagnostic, Range } from "./types.js";
import type { AstDocument } from "./yaml-ast.js";
import type { SourceFailureKind } from "./sources/source-failure.js";

/** One physical file's parsed result. Returned for the owner manifest, for
 *  each `include:` partial, and for each external import target.
 *
 *  Identity rule: every map key, every cross-reference, every editor-side
 *  cache uses `source` — the URL the source adapter's `read()` returned. */
export interface LoadedFile {
  /** Canonical identity. The URL the source adapter's `read()` returned —
   *  HTTPS for a remote module, an absolute path for local. */
  source: string;
  /** The URL the caller supplied (e.g. `oci://ghcr.io/telorun/javascript@0.3.0`).
   *  Differs from `source` only for adapter-resolved URLs. */
  requestedUrl: string;
  /** Raw text exactly as `read()` returned it. */
  text: string;
  /** Per-document parsed `yaml` AST, in source order. The editor's mutable
   *  round-trip model reads this handle; structure-only consumers use the
   *  read-only `astDocuments` instead so `yaml` stays an internal detail. */
  documents: Document[];
  /** Per-document read-only `AstNode` view (`yaml`-free), aligned to
   *  `documents`. The shared structural source of truth for IDE features. */
  astDocuments: AstDocument[];
  /** Per-document JSON projection (`doc.toJSON()`). Aligned to `documents`. */
  manifests: Array<ResourceManifest | null>;
  /** Per-document `{sourceLine, positionIndex}`. Aligned to `documents`. */
  positions: DocumentPosition[];
  /** Document-level parse errors aggregated from `yaml.Document.errors`. */
  parseErrors: ParseError[];
  /** What the migration phase rewrote in this file, and the diagnostics for it.
   *  Empty unless the load opted into `migrate` AND a legacy spelling matched.
   *  `manifests` above are the POST-migration tree; `documents` / `astDocuments`
   *  / `positions` / `text` are always the author's file untouched, which is
   *  what the recorded `legacyPath` resolves against. */
  migrations: FileMigrations;
  /** Every CEL expression precompiled in this file, each against the file's one
   *  site environment. Present only for a load that compiled. */
  celProgramSites?: readonly CelProgramSite[];
}

export interface ParseError {
  documentIndex: number;
  /** The diagnostic code, when the refusal is one the loader names
   *  (`loader-expansion-refusals.ts`); otherwise `MANIFEST_PARSE_FAILED`. */
  code?: string;
  message: string;
  /** Line/character of the failure, when the yaml parser provided one. */
  range?: Range;
  /** The refused value's path in its document, for a refusal at an import's
   *  own field (`imports.Lib.source`, `source`). */
  path?: string;
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
 *  identity it resolves to. Carrying the name on the edge means
 *  `flattenForAnalyzer` can stamp `metadata.resolvedModuleName` from this
 *  single source rather than re-deriving the target from manifest metadata,
 *  which would silently miss whenever a future projection forgets to stamp
 *  `metadata.source` consistently. */
export interface ImportEdge {
  /** Canonical resolved URL of the target — a key into `modules`. */
  targetSource: string;
  /** The import's `source` exactly as authored — an `oci://` or `https://`
   *  ref, or a relative path. Version reconciliation keys on
   *  this (minus its version), since it names the module's location
   *  independently of what the module declares about itself. */
  targetRef: string;
  /** Target library's `metadata.name`. Never absent: an import whose target
   *  names no library identity registers no edge at all and is reported in
   *  `LoadedGraph.errors`, so an edge that exists is one every consumer can
   *  resolve a kind through. */
  targetModuleName: string;
  /** DEPRECATED. Target library's `metadata.namespace`, or `null` when it
   *  declares none. Feeds only the legacy `<namespace>/<module>#<Kind>` form
   *  of `x-telo-ref`; nothing else reads it. */
  targetNamespace: string | null;
}

/** One holder on the way from a module's top level to a scope member: the
 *  holder's name, the scope field and the index of the next step in it. */
export interface ScopeHolderStep {
  readonly name: string;
  readonly field: string;
  readonly index: number;
}

/** One option on the way to a scoped import a choice writes: the tag's keys in
 *  the top-level document and the branch taken there (`then`, `else`,
 *  `default`, `case:<key>`). */
export interface ScopedImportOption {
  readonly at: readonly (string | number)[];
  readonly branch: string;
}

/** A `Telo.Import` declared as a scope member, resolved as an `imports:` entry
 *  is — wherever a choice writes it, so the graph is the union over every
 *  configuration. It names a module instance of its own, never a module alias. */
export interface ScopedImportEdge extends ImportEdge {
  /** The member's name — its `metadata.name`, or the name the tag declaring it
   *  at a scope-member position gives it. */
  alias: string;
  /** The holders from the declaring module's top level down to the scope. */
  holders: readonly ScopeHolderStep[];
  /** The top-level holder's kind, as written — the tag (`!if`) for a holder a
   *  whole-document choice declares. */
  holderKind: string;
  /** The member, as the declaring file holds it: for one a choice declares at
   *  a scope-member position, the branch. */
  member: Record<string, unknown>;
  /** Where the member is written in its top-level document, option keys
   *  included (`with.then[0]`, `with[0].then`, `then.with[0]`). */
  place: readonly (string | number)[];
  /** Its presence: every option on the way to it, outermost first — none for a
   *  member no choice writes. */
  options: readonly ScopedImportOption[];
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
  /** Every `Telo.Import` declared as a scope member, by the file declaring it,
   *  in document order. Kept apart from `importEdges`: such an import gives its
   *  scope instance names and no module alias. */
  scopedImportEdges?: Map<string, ScopedImportEdge[]>;
  /** Version-reconciliation redirects: a losing module's canonical source URL →
   *  the winning version's canonical source URL. The runtime consults this when
   *  it independently re-resolves an import (the analyzer already sees repointed
   *  `importEdges`). Empty when no module identity appeared at two sources. */
  overrides: Map<string, string>;
  /** Deprecation diagnostics from the loader's migration phase, scoped to the
   *  ENTRY's own module (owner + its `include:` partials). A migration rewrites
   *  always — the runtime must read artifacts published years ago — but reports
   *  only here, because a published dependency is not the consumer's to fix.
   *  Empty unless the load opted into `migrate`. */
  migrationDiagnostics: AnalysisDiagnostic[];
  /** Diagnostics produced while reconciling module versions — one per import
   *  edge redirected to a different version (warning for a same-major hoist,
   *  error for a major mismatch). Surfaced alongside `analyze()` diagnostics by
   *  every consumer (CLI, editor, VS Code). */
  versionDiagnostics: AnalysisDiagnostic[];
  /** One diagnostic per tagged file claim that names nothing (`!include-text` /
   *  `!include-bytes` → `INCLUDE_FILE_NOT_FOUND`, `!module-path` →
   *  `MODULE_PATH_NOT_FOUND`), in the entry and every module it reaches through
   *  a filesystem-path or `http(s)://` import — asked of each module's source at load, since
   *  existence needs a filesystem and analysis runs without one. A path at or
   *  above a module file the module's `sources:` stages counts as present. Empty
   *  for a module whose source cannot answer (`ManifestSource.entryAt`). A value
   *  whose one claim names something is stamped with what it names (`FOUND_ENTRY`). */
  moduleFileDiagnostics: AnalysisDiagnostic[];
  /** One `METADATA_RESERVED_FIELD` per loader stamp an author wrote in a
   *  document's `metadata`, in the entry (where written) and every module it
   *  reaches (at the entry's import first reaching it). Fatal at load. */
  metadataDiagnostics: AnalysisDiagnostic[];
  /** YAML parse failures aggregated from every file's `parseErrors`. A file
   *  that fails to parse yields a mangled `toJSON()` projection, so these are
   *  fatal Error diagnostics — surfaced alongside `analyze()` output by every
   *  consumer (CLI, editor, VS Code) and treated as fatal by the kernel.
   *  Also the refusal of an entry the loader cannot read as a module at all —
   *  a `Telo.Builtins` archive (`UNDEFINED_KIND`) — which is fatal for the same
   *  reason and holds back the same cascade. */
  parseDiagnostics: AnalysisDiagnostic[];
  /** Surface-level errors that did not abort the graph load (e.g. an import
   *  whose target failed to fetch). */
  errors: GraphLoadError[];
  /** Every child application a resource of the ENTRY's own files names at an
   *  `x-telo-application-source` field, keyed by the declaring file and then by
   *  the source exactly as written: the child's own graph, loaded without
   *  following its children in turn, or why it could not be. Nothing here fails
   *  the load — the analysis reports a failure at the field that names it, and
   *  only for a resource whose kind really carries the annotation. */
  applicationSources?: Map<string, Map<string, ApplicationSourceLoad>>;
  /** The same for every module but the entry, which the dependency verdict
   *  judges as an entry of its own; never read by the entry's analysis. */
  moduleApplicationSources?: Map<string, Map<string, ApplicationSourceLoad>>;
  /** The load variant the graph was read in (`LoadOptions.migrate`): the
   *  library migration stage runs only over a migrated load, never over a
   *  round-trip view. */
  migrate: boolean;
  /** The library migration stage's result, set by the registration that ran it
   *  (`registerLoadedGraph`) and carried by every graph re-rooted from this one.
   *  When set, `modules` holds the graph's own copies of every module whose
   *  closure reaches a library declaring `migrations:`, already migrated. Absent
   *  when no library of the closure declares migrations. */
  libraryMigrations?: LibraryMigrationOutcome;
}

/** One child application source, as the loader found it. */
export type ApplicationSourceLoad = { graph: LoadedGraph } | { failure: GraphLoadError };

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
  /** Why this import is unusable. `"unresolved"` (the default) means the target
   *  was never obtained — an unreachable or unrecognizable source, which the
   *  author fixes in their own file. `"unusable-target"` means it WAS obtained
   *  and is not an importable library, which is a defect in the target module.
   *  Kept apart because the two call for different actions; consumers phrase
   *  them differently rather than asserting one cause for both.
   *  `"reserved-prefix"` means the import's alias, or the name of the library it
   *  reached, is `Telo` or `Self` (`reserved-kind-prefix.ts`): registering it
   *  would replace the built-in or the module's own kinds.
   *  `"branch-position"` / `"repeat-outside-template"` mean a scope member's
   *  alias, kind, source or integrity is written behind an expansion construct
   *  (`importFieldRefusals`), so nothing was loaded; `error.message` is the
   *  whole sentence. */
  reason?: "unresolved" | "unusable-target" | "reserved-prefix" | "branch-position" | "repeat-outside-template";
  /** Set for an import declared as a scope member, which has no `imports:`
   *  entry: the top-level holder and the member's place in it (`with[0]`). */
  scope?: { holder: { kind: string; name: string }; path: string };
  /** The kind of source failure that left the target unobtained, when its
   *  source named one (`sources/source-failure.ts`); `error.message` is then
   *  that failure's sentence. */
  sourceFailure?: SourceFailureKind;
  error: Error;
}
