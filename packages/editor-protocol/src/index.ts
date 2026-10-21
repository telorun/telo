// The Telo editor protocol: what an editor host and a telo language-server
// engine say to each other beyond LSP itself. Zero dependencies and no runtime
// beyond constants, so a host of any telo version — and a host in any language,
// through `editor-protocol-schema.json` — can speak it. `README.md` is the spec.

/** The protocol generation this package describes. Additions within a
 *  generation are negotiated by capability; an incompatible change bumps it. */
export const TELO_EDITOR_PROTOCOL = 1;

/** What an engine advertises under `ServerCapabilities.experimental`. */
export interface TeloExperimentalCapabilities {
  telo: TeloProtocolCapability;
}

export interface TeloProtocolCapability {
  /** The generation the engine speaks. */
  protocol: number;
  /** The engine serves `telo/viewModel` and `telo/celCompletion` and sends
   *  `telo/viewModelChanged`. */
  viewModel?: boolean;
}

/** The file a module directory is read as: `telo/read` of a directory answers
 *  with this file inside it. */
export const TELO_MODULE_FILENAME = "telo.yaml";

/** `initialize`'s `serverInfo.name` for every telo engine. Its
 *  `serverInfo.version` is the engine's identity: the telo version `X` for a
 *  release build, `X+unreleased` for a build made while that release is still
 *  pending. */
export const TELO_SERVER_NAME = "telo";

/** Method names of every `telo/*` message: the requests an engine sends and a
 *  host serves, the requests a host sends and an engine serves, and the
 *  notifications an engine sends. */
export const TeloMethod = {
  read: "telo/read",
  exists: "telo/exists",
  listDirectory: "telo/listDirectory",
  hubSearchRefs: "telo/hub/searchRefs",
  hubListVersions: "telo/hub/listVersions",
  requirements: "telo/requirements",
  viewModel: "telo/viewModel",
  celCompletion: "telo/celCompletion",
  viewModelChanged: "telo/viewModelChanged",
} as const;
export type TeloMethod = (typeof TeloMethod)[keyof typeof TeloMethod];

// --- Host-served requests (engine → host) ---------------------------------

/** `telo/read`: the text at `uri`. `uri` is a document URI (`file:///…`) or an
 *  import source (`oci://host/repo@1.2.0`, `https://…`); the host reads it
 *  through whatever transport it owns. */
export interface ReadParams {
  uri: string;
}

/** The text read, with the CANONICAL location it was read from — a directory
 *  resolves to its {@link TELO_MODULE_FILENAME}, an `oci://` tag to the reference the host
 *  resolved. `null` when nothing exists at `uri`; any other failure is a
 *  JSON-RPC error carrying its reason. */
export type ReadResult = { uri: string; text: string } | null;

/** `telo/exists`: whether a file or directory exists at `relative`, resolved
 *  against the DIRECTORY of the file `base` names. */
export interface ExistsParams {
  base: string;
  relative: string;
}
export type ExistsResult = boolean;

/** `telo/listDirectory`: the entries of the directory at `uri`. */
export interface ListDirectoryParams {
  uri: string;
}
/** What a directory entry is, read WITHOUT following a link: a symbolic link
 *  is `symlink` whatever it points at. A receiver reads a kind it does not know
 *  as `other`. */
export type DirectoryEntryKind = "file" | "directory" | "symlink" | "other";
export interface DirectoryEntry {
  name: string;
  kind: DirectoryEntryKind;
}
/** `null` when `uri` names nothing or names a file. */
export type ListDirectoryResult = DirectoryEntry[] | null;

/** `telo/hub/searchRefs`: module refs the configured telo hub matches `query`
 *  against (a substring over every registered ref). */
export interface SearchRefsParams {
  query: string;
}
export interface HubRef {
  ref: string;
  latestVersion: string;
  description?: string;
}
export type SearchRefsResult = HubRef[];

/** `telo/hub/listVersions`: every version the hub tracks for a location ref,
 *  newest first, each with its import pin when the hub has one. `[]` for a ref
 *  the hub does not track; an unreachable hub is a JSON-RPC error. */
export interface ListVersionsParams {
  ref: string;
}
export interface ModuleVersion {
  version: string;
  /** Canonical `sha256-<base64url>` pin. */
  integrity?: string;
}
export type ListVersionsResult = ModuleVersion[];

/** Params and result of every host-served request, by method. */
export interface TeloHostRequests {
  "telo/read": [ReadParams, ReadResult];
  "telo/exists": [ExistsParams, ExistsResult];
  "telo/listDirectory": [ListDirectoryParams, ListDirectoryResult];
  "telo/hub/searchRefs": [SearchRefsParams, SearchRefsResult];
  "telo/hub/listVersions": [ListVersionsParams, ListVersionsResult];
}

// --- Engine → host notification -------------------------------------------

/** One edge of a version interval. */
export interface VersionBound {
  version: string;
  inclusive: boolean;
}

/** A `requires: telo:` range reduced to its edges; an absent edge is open. */
export interface VersionInterval {
  min?: VersionBound;
  max?: VersionBound;
}

export interface RequirementsRange {
  /** URI of the module document declaring the range. */
  module: string;
  /** The range as written. */
  text: string;
  interval: VersionInterval;
}

/** `telo/requirements`: sent after each analysis of an owner module. */
export interface RequirementsParams {
  /** URI of the owner module's `telo.yaml` (or standalone manifest). */
  owner: string;
  /** URIs of the owner's member documents — the owner and every partial it
   *  includes. A host routes these documents to the engine chosen for `owner`. */
  documents: string[];
  /** Every `requires: telo:` range in the owner's import closure. The owner
   *  itself declares one exactly when an entry's `module` equals `owner`. */
  ranges: RequirementsRange[];
}

/** `telo/viewModelChanged`: the owner's view model moved — sent after each
 *  analysis of the owner, and when the owner stops being analysed (a
 *  `telo/viewModel` for it then answers `null`). */
export interface ViewModelChangedParams {
  /** Canonical `file:` URI of the owner module's document. */
  owner: string;
  /** Increases with every analysis of the owner, and when it is dropped. */
  revision: number;
}

// --- Engine-served requests (host → engine) --------------------------------

/** `telo/viewModel`: the structured-view model of one owner module. */
export interface ViewModelParams {
  owner: string;
}
/** `null` when the engine is not analysing `owner`. */
export type ViewModelResult = ViewModel | null;

/** `telo/celCompletion`: completion for a CEL value typed into a structured
 *  form field, which is not document text yet. */
export interface CelCompletionParams {
  owner: string;
  /** The resource the field belongs to. */
  resource: { kind: string; name: string };
  /** Concrete path of the field within the resource (`routes[0].handler.inputs.x`). */
  path: string;
  /** The tag the value is written under, without its `!` (`cel`, `interpolate`). */
  tag: string;
  /** The field's value without its tag. */
  text: string;
  /** Cursor offset into `text`. */
  offset: number;
}
/** LSP `CompletionItem`s; a `textEdit` range is a line/character range in
 *  `text`. Empty when the engine is not analysing `owner`. */
export type CelCompletionResult = CompletionItem[];

/** The members of an LSP `CompletionItem` an engine sets. */
export interface CompletionItem {
  label: string;
  /** LSP `CompletionItemKind`. */
  kind?: number;
  detail?: string;
  documentation?: string;
  insertText?: string;
  /** LSP `InsertTextFormat`; 2 is a snippet. */
  insertTextFormat?: number;
  textEdit?: { range: TextRange; newText: string };
  preselect?: boolean;
  sortText?: string;
  filterText?: string;
  command?: { title: string; command: string };
}

export interface TextRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** Params and result of every engine-served request, by method. */
export interface TeloEngineRequests {
  "telo/viewModel": [ViewModelParams, ViewModelResult];
  "telo/celCompletion": [CelCompletionParams, CelCompletionResult];
}

// --- The view model ---------------------------------------------------------

/** A JSON Schema, as plain JSON. */
export type JsonSchema = Record<string, unknown>;

/**
 * What a structured editor (a module canvas, a schema form, a reference picker)
 * reads about one owner module, computed by the engine of the module's telo
 * version over the same analysis its diagnostics come from.
 */
export interface ViewModel {
  owner: string;
  revision: number;
  /** The owner module drawn as a graph. */
  moduleGraph: ModuleGraphData | null;
  /** The schema of the owner's module document kind. */
  moduleRootSchema: JsonSchema | null;
  /** Each `kind:` spelling in the closure, and each constraint in
   *  `refConstraints`, mapped to the canonical kind it resolves to. A spelling
   *  that resolves to nothing is absent. */
  kindSpellings: Record<string, string>;
  /** Per reference-slot constraint: the canonical kinds that satisfy it and the
   *  spellings a new resource could be created with. A constraint that resolves
   *  to nothing is absent. */
  refConstraints: Record<string, RefConstraint>;
  /** Invocation contracts of every kind declaring one, by canonical kind. */
  contracts: Record<string, KindContract>;
  /** Why a resource of the owner module cannot fill a slot, by what it returns:
   *  one entry per reference slot declaring an `outputType` in the closure's
   *  kinds. */
  outputRefusals: OutputRefusals[];
  /** The body of every templated kind in the closure, by canonical kind. */
  templates: Record<string, TemplateGraphData>;
  /** Every reference written in the owner module's resources and its module
   *  document. */
  referenceSites: ReferenceSite[];
  /** Canonical URI → the LSP version of each open document the analysis read.
   *  A host holding a newer version of one of them holds text this model was
   *  not computed from. */
  documents: Record<string, number>;
}

export interface RefConstraint {
  accepted: string[];
  userFacing: string[];
}

export interface KindContract {
  inputType?: JsonSchema;
  outputType?: JsonSchema;
}

export interface OutputRefusals {
  /** The canonical kind declaring the slot. */
  kind: string;
  /** JSON Pointer of the slot's `x-telo-ref` node within that kind's `schema`. */
  pointer: string;
  /** Resource name, in the scope the entry is listed in (the owner module, or
   *  a template's body), → one line per definite mismatch. A resource absent
   *  here can fill the slot. */
  refusals: Record<string, string[]>;
}

export interface TemplateGraphData {
  /** Canonical `<module>.<Name>`. */
  kindId: string;
  name: string;
  module?: string;
  /** The kind's capability, inherited along `extends`. */
  capability?: string;
  /** The definition document as analysed; `metadata.source` is a document URI. */
  definition: Record<string, unknown>;
  graph: ModuleGraphData;
  /** Why an entry of the body cannot fill a slot, by what it returns — the
   *  owner's `outputRefusals`, judged over the body's entries. */
  outputRefusals: OutputRefusals[];
}

export interface ReferenceSite {
  /** The resource writing the reference; the module document as itself. */
  source: { kind: string; name: string };
  /** Concrete path of the slot within that resource. */
  path: string;
  /** The name the reference holds, as written (`Alias.name` across an import). */
  target: string;
}

/** A module drawn as boxes, ordered rows and classed edges — the analyzer's
 *  module graph as data. */
export interface ModuleGraphData {
  root?: GraphNodeData;
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  regions: GraphRegionData[];
  kinds: GraphKindData[];
}

/** `root` | `named` | `inline` | `scoped` | `imported` | `injected` |
 *  `enclosing` | `forwarded`. */
export type NodeOwnership = string;
/** `flow` | `holds` | `shape` | `data`. */
export type EdgeClass = string;
/** `step` | `entry` | `target` | `inline` | `reference` | `export`. */
export type RowKind = string;

export interface GraphNodeData {
  id: string;
  kind: string;
  name: string;
  capability?: string;
  canonicalKind?: string;
  unknownKind?: boolean;
  ownership: NodeOwnership;
  owner?: string;
  ownerSite?: string;
  module?: string;
  external?: boolean;
  alias?: string;
  ports: GraphPortData[];
  rows: GraphRowData[];
  rowArrays: { field: string; kind: RowKind }[];
  throws?: { codes: string[]; unbounded: boolean };
  root?: boolean;
}

export interface GraphPortData {
  slot: string;
  refs: string[];
  capabilities: string[];
  array: boolean;
  class: EdgeClass;
  slots: { path: string; target?: string; targetNode?: string; inline?: boolean }[];
  addPath?: string;
  rowOwned?: boolean;
}

export interface GraphRowData {
  id: string;
  kind: RowKind;
  name?: string;
  path: string;
  array: string;
  index: number;
  depth: number;
  parent?: string;
  target?: string;
  targetNode?: string;
  inputs?: string;
  match?: Record<string, unknown>;
  variant?: string;
  variantLabel?: string;
  predicate?: string;
  catches?: boolean;
  dispatch?: {
    path: string;
    refs: string[];
    inline?: boolean;
    alternatives?: { path: string; refs: string[] }[];
  };
  declares?: string;
  unknownKind?: boolean;
}

export interface GraphEdgeData {
  id: string;
  from: string;
  to?: string;
  toName: string;
  class: EdgeClass;
  /** `schema` | `dependency` | `call` | `detached` | `trigger.inbound` |
   *  `trigger.consumer`. */
  use: string[];
  slot: string;
  path: string;
  row?: string;
  inputs?: string;
  boot?: boolean;
  scoped?: boolean;
  read?: string;
  call?: string;
}

export interface GraphRegionData {
  id: string;
  /** `inline` | `scope` | `zone`. */
  kind: string;
  owner: string;
  site: string;
  members: string[];
  attributes?: Record<string, string>;
  boundaries?: { from: string; toName: string; escaping: string[] }[];
}

export interface GraphKindData {
  id: string;
  name: string;
  module?: string;
  abstract: boolean;
  capability?: string;
  extendsId?: string;
  extendsName?: string;
  instances: string[];
  template: boolean;
  own: boolean;
  exported?: boolean;
}

// --- Diagnostic.data -------------------------------------------------------

/** The YAML tags a repair may write. A receiver that does not know a tag
 *  offers no fix for it. */
export type DiagnosticFixTag = "ref" | "cel" | "module-path";

/** A mechanically applicable repair: the whole corrected value at the
 *  diagnostic's range, written behind `tag` when one is present. */
export interface DiagnosticFix {
  replacement: string;
  tag?: DiagnosticFixTag;
}

/** What an engine puts in `Diagnostic.data`. A host hands the diagnostic back
 *  unchanged in `codeAction`'s context, which is how a fix round-trips. */
export interface TeloDiagnosticData {
  fix?: DiagnosticFix;
  /** The resource the diagnostic is pinned to. */
  resource?: { kind: string; name: string };
  /** Dotted path of the offending value within that resource. */
  path?: string;
}

// --- Commands --------------------------------------------------------------

/** `workspace/executeCommand` commands an engine serves. The two upgrade
 *  commands take `[{ uri, aliases }]` and apply through `workspace/applyEdit`;
 *  refresh takes no argument. */
export const TeloCommand = {
  upgradeImport: "telo.upgradeImport",
  upgradeAllImports: "telo.upgradeAllImports",
  refreshImportUpgrades: "telo.refreshImportUpgrades",
} as const;
export type TeloCommand = (typeof TeloCommand)[keyof typeof TeloCommand];

export interface UpgradeImportsArguments {
  uri: string;
  aliases: string[];
}
