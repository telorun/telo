/**
 * The Telo module ecosystem's pure half of the release model — module identity,
 * the `telo.yaml` version stamp, a module artifact's layer keys, destinations —
 * and `telo-workspace.yaml` as a Telo host reads it. The generic planner is
 * `@telorun/release`; everything Node-shaped is `cli/nodejs/src/release/`.
 */

export {
  LOCALLY_DERIVED_LAYERS,
  MANIFEST_LAYER,
  layerDigestKey,
} from "./payload-digest.js";
export type { LayerDigests } from "./payload-digest.js";

export {
  VersionStampError,
  readManifestVersion,
  stampManifestVersion,
  stampSelfNpmPins,
} from "./version-stamp.js";

export {
  MODULE_MANIFEST,
  TELO_ECOSYSTEM,
  TELO_RELEASE_ADAPTERS,
  modulePackageFiles,
  teloAdapter,
  teloLegacyLedgerLayers,
} from "./telo-adapter.js";

export { checkDestinationCollisions } from "./destinations.js";
export type { ModuleDestination } from "./destinations.js";

export {
  DEFAULT_ENV_FILES,
  WORKSPACE_FILENAME,
  matchesPatterns,
  readWorkspaceConfig,
} from "./workspace-config.js";
export type {
  AuditIgnoreEntry,
  AuditSettings,
  EnvFileEntry,
  EnvSettings,
  PatternMatch,
  WorkspaceConfig,
  WorkspaceRead,
} from "./workspace-config.js";

export {
  AUDIT_BLOCK_SCHEMA,
  AUDIT_IGNORE_ENTRY_KEYS,
  ENV_BLOCK_SCHEMA,
  ENV_FILE_ENTRY_KEYS,
  WORKSPACE_BLOCKS,
  WORKSPACE_SCHEMA,
  workspaceSchema,
} from "./workspace-schema.js";
