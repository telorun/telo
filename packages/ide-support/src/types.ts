// Runtime values (classes, enums) — consumers who need `new AnalysisRegistry()`
// or `DiagnosticSeverity.Error` import from here.
export { AnalysisRegistry, DiagnosticSeverity } from "@telorun/analyzer";

// Pure types.
export type {
  Position,
  Range,
  AnalysisDiagnostic,
  PositionIndex,
} from "@telorun/analyzer";

import type { AnalysisRegistry, DiagnosticSeverity, PositionIndex, Range } from "@telorun/analyzer";

export type CompletionKind = "class" | "enumMember" | "property" | "folder" | "module" | "value";

export interface CompletionResult {
  label: string;
  kind: CompletionKind;
  detail?: string;
  documentation?: string;
  insertText?: string;
  snippet?: boolean;
  preselect?: boolean;
  sortText?: string;
  filterText?: string;
  /** When set, the host should replace text from this 0-based column on the
   *  cursor's line up to the cursor. Required when the completion value
   *  contains non-word characters (`/`, `@`, `.`) that the host's default
   *  word boundary would not include in the replaced range. */
  replaceFromColumn?: number;
}

/** A candidate module ref surfaced by the hub's `/refs` lexical autocomplete.
 *  Identity is the location ref, never `namespace/name` — an OCI module has no
 *  addressable `namespace/name`. `latestVersion` seeds a pinned `ref@version`
 *  insert so a picked completion is directly usable. */
export interface HubRef {
  ref: string;
  latestVersion: string;
  description?: string;
}

/** Host-supplied bridge that lets ide-support reach the filesystem and the
 *  federated telo hub without depending on Node, Tauri, or vscode APIs. Each
 *  host (VSCode extension, Telo editor) builds an adapter scoped to the
 *  currently-edited manifest before calling `buildCompletions`. Hub lookups are
 *  ref-keyed: the hub aggregates modules across every transport (OCI, HTTP,
 *  direct URL), so completion speaks its `/refs` + `/module/versions` verbs
 *  rather than any single registry. */
export interface IdeEnvironmentAdapter {
  /** Subdirectory names within `relPath` (resolved against the manifest's
   *  directory). Returns [] if the path doesn't exist or isn't a directory.
   *  Never throws — hosts swallow ENOENT and similar. */
  listDirectories(relPath: string): Promise<string[]>;
  /** True iff `<relPath>/telo.yaml` exists relative to the manifest dir.
   *  Used to mark directories that are valid import targets. */
  hasManifest(relPath: string): Promise<boolean>;
  /** Fuzzy lexical ref autocomplete against the configured telo hub
   *  (`GET /refs?q=`). The query is matched as a substring over every
   *  registered ref, so a bare token (`youtrack`) hits the same ref as its full
   *  `oci://…` form. Best-effort — hosts swallow network errors and return []. */
  searchRefs(query: string): Promise<HubRef[]>;
  /** All tracked versions for a location ref, newest first
   *  (`GET /module/versions?ref=`). The browser cannot call OCI `tags/list`;
   *  the hub holds them from ingest. */
  listVersionsForRef(ref: string): Promise<string[]>;
}

export interface NormalizedDiagnostic {
  range: Range;
  severity: DiagnosticSeverity;
  code: string;
  source: string;
  message: string;
  suggestions?: Array<{ kind: "replace-kind"; replacement: string }>;
  /** Preserved verbatim from the source `AnalysisDiagnostic`. Carries
   *  resource/path stamps that downstream UIs (popovers, "at <path>" hints,
   *  CodeAction wiring) read after normalization. Opaque on purpose so this
   *  module doesn't pin a shape that the analyzer evolves over time. */
  data?: unknown;
}

export interface DiagnosticContext {
  registry: AnalysisRegistry;
  positionIndex?: PositionIndex;
  sourceLine?: number;
}
