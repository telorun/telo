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
}

/** The file a module directory is read as: `telo/read` of a directory answers
 *  with this file inside it. */
export const TELO_MODULE_FILENAME = "telo.yaml";

/** `initialize`'s `serverInfo.name` for every telo engine. Its
 *  `serverInfo.version` is the engine's identity: the telo version `X` for a
 *  release build, `X+unreleased` for a build made while that release is still
 *  pending. */
export const TELO_SERVER_NAME = "telo";

/** Method names of the requests an engine sends and a host serves, and of the
 *  notification an engine sends. */
export const TeloMethod = {
  read: "telo/read",
  exists: "telo/exists",
  listDirectory: "telo/listDirectory",
  hubSearchRefs: "telo/hub/searchRefs",
  hubListVersions: "telo/hub/listVersions",
  requirements: "telo/requirements",
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
