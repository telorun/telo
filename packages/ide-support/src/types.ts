// Runtime values (classes, enums) — consumers who need `new AnalysisRegistry()`
// or `DiagnosticSeverity.Error` import from here.
export { AnalysisRegistry, DiagnosticSeverity, DiagnosticTag } from "@telorun/analyzer";

// Pure types.
export type {
  Position,
  Range,
  AnalysisDiagnostic,
  PositionIndex,
} from "@telorun/analyzer";

import type {
  AnalysisRegistry,
  DiagnosticFixTag,
  DiagnosticSeverity,
  DiagnosticTag,
  Position,
  PositionIndex,
  Range,
} from "@telorun/analyzer";

export type CompletionKind =
  | "class"
  | "enumMember"
  | "property"
  | "folder"
  | "file"
  | "module"
  | "value"
  | "keyword";

/** A source span the host replaces wholesale when a completion is accepted. */
export interface ReplaceRange {
  start: Position;
  end: Position;
}

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
  /** When set, the host replaces this whole source range with the accepted
   *  value — the full span of the existing node, not just the prefix up to the
   *  cursor. This overwrites any suffix after the cursor (`Sql.Co|nnection` +
   *  `Sql.Connection` → no leftover `nnection`) and cleanly replaces values
   *  containing non-word characters (`/`, `@`, `.`). A zero-width range is a
   *  pure insert. */
  replaceRange?: ReplaceRange;
  /** The host reopens completion once this item is accepted — what comes next
   *  has completions of its own (a tag's value, a directory's entries). */
  retrigger?: boolean;
}

/** Rendered hover for the symbol under the cursor. `contents` is GitHub-flavored
 *  markdown; `range` (when present) is the source span the host underlines. */
export interface HoverResult {
  contents: string;
  range?: ReplaceRange;
}

/** Signature help for the call the cursor is inside. Each parameter's `label` is
 *  its `[start, end]` span inside the signature's own `label`, the form both
 *  VS Code and Monaco highlight the active parameter by. */
export interface SignatureHelpResult {
  signatures: Array<{
    label: string;
    documentation?: string;
    parameters: Array<{ label: [number, number]; documentation?: string }>;
  }>;
  activeSignature: number;
  activeParameter: number;
}

/** Semantic token type names emitted by `buildSemanticTokens`. Kept to the
 *  standard VS Code / LSP set so hosts register them against a stock legend and
 *  every theme colors them without extra configuration.
 *
 *  Manifest structure: `type` marks a resolved resource kind; `interface` marks
 *  a capability value; `variable` marks a `!ref` target.
 *
 *  Inside a CEL body: `namespace` marks the ROOT of a chain, `property` a member
 *  it can resolve, `function` a call, and `number` / `string` / `keyword` /
 *  `operator` the syntax around them. A CEL name the scope CANNOT confirm gets
 *  no token — the same quiet signal an unresolved `kind:` gives, pairing with
 *  the analyzer's `CEL_UNKNOWN_FIELD`.
 *
 *  The root is a `namespace` rather than a `variable` because colour encodes
 *  what a symbol IS, which is the invariant every language holds to — and a CEL
 *  root is not data the author declared, it is a scope the runtime injects
 *  (`request`, `steps`, `variables`, `self`). Members are uniformly `property`
 *  however deep, so a chain reads as scope · path. Colouring by the SHAPE of the
 *  value behind a name — object vs scalar — was considered and rejected: it is
 *  type-directed highlighting, so the palette becomes a type legend, a name
 *  changes colour as analysis resolves, and it says nothing exactly where the
 *  scope declares no shape. */
export type SemanticTokenType =
  | "type"
  | "interface"
  | "variable"
  | "property"
  | "function"
  | "number"
  | "string"
  | "keyword"
  | "operator"
  | "namespace";

/** The legend a host registers before mapping `buildSemanticTokens` output. The
 *  numeric token-type of each `SemanticToken` is its index in this array, and a
 *  host registers it once at activation — so new types are APPENDED, never
 *  inserted, or an already-registered legend would repaint every existing
 *  token as something else. */
export const SEMANTIC_TOKEN_LEGEND: readonly SemanticTokenType[] = [
  "type",
  "interface",
  "variable",
  "property",
  "function",
  "number",
  "string",
  "keyword",
  "operator",
  "namespace",
];

/** One absolute-positioned semantic token. Every Telo semantic token is
 *  single-line (kinds and capabilities never wrap), so a `{line, char, length}`
 *  triple is sufficient; the host encodes it into its own builder. */
export interface SemanticToken {
  line: number;
  character: number;
  length: number;
  type: SemanticTokenType;
}

/** Where a `!ref` target is defined — for go-to-definition. `uri` is the
 *  target file's canonical source (absolute path for local files, an http/oci
 *  URL for a registry import); `range` spans the target resource's
 *  `metadata.name` (falling back to its first line). */
export interface DefinitionResult {
  uri: string;
  range: Range;
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
  /** Entries of `relPath`, resolved against the ROOT of the module the manifest
   *  belongs to — the directory every `!include-*` / `!module-path` path is
   *  measured from, which for a partial is not the partial's own directory.
   *  Returns [] if the path doesn't exist or isn't a directory. */
  listModuleEntries(relPath: string): Promise<ModuleEntry[]>;
}

export interface ModuleEntry {
  name: string;
  directory: boolean;
}

export interface NormalizedDiagnostic {
  range: Range;
  severity: DiagnosticSeverity;
  code: string;
  source: string;
  message: string;
  /** Mechanically applicable repairs. `replacement` is the whole corrected
   *  value at the diagnostic's range — apply it by replacing that range,
   *  rendered through `renderFixReplacement` with `tag` when one is present. */
  suggestions?: Array<{ kind: "replace"; replacement: string; tag?: DiagnosticFixTag }>;
  /** LSP diagnostic tags, carried through verbatim. Orthogonal to `severity`:
   *  they say what KIND of thing the range is (deprecated, unnecessary), which
   *  is what a host renders as strikethrough or fading rather than as a colour. */
  tags?: DiagnosticTag[];
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
