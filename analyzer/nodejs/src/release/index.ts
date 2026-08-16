/**
 * The release model: module identity, fragments, the ledger, the edge graph,
 * level propagation and version planning.
 *
 * Browser-safe by construction — pure data in, plan out — so the telo editor can
 * answer "what does changing this library bump?" from the same model the CLI
 * releases from. Everything Node-shaped (finding the workspace, running the
 * controller builder, building payloads, reading git, writing files) is
 * `cli/nodejs/src/release/`.
 */

export {
  FRAGMENT_KINDS,
  FRAGMENT_KIND_ORDER,
  applyBump,
  compareVersions,
  isFragmentKind,
  isReleaseVersion,
  levelOfKind,
  maxLevel,
} from "./bump-level.js";
export type { BumpLevel, FragmentKind } from "./bump-level.js";

export {
  CHANGELOG_HEADER,
  prependChangelogRelease,
  renderChangelogRelease,
} from "./changelog.js";
export type { ChangelogRelease } from "./changelog.js";

export { FragmentError, normalizeModuleKey, parseFragment, serializeFragment } from "./fragment.js";
export type { ModuleKey, ReleaseFragment } from "./fragment.js";

export { EMPTY_LEDGER, LEDGER_PATH, LedgerError, parseLedger, serializeLedger } from "./ledger.js";
export type { Ledger, LedgerEntry } from "./ledger.js";

export {
  LOCALLY_DERIVED_LAYERS,
  MANIFEST_LAYER,
  diffLayerDigests,
  layerDigestKey,
} from "./payload-digest.js";
export type { LayerChange, LayerDigests } from "./payload-digest.js";

export { orderByImports, planRelease } from "./release-plan.js";
export type {
  ArtifactKind,
  BumpReason,
  ChangelogEntry,
  ModuleEvidence,
  PlannedModule,
  ReleaseDiagnostic,
  ReleaseEvidence,
  ReleasePlan,
} from "./release-plan.js";

export {
  VersionStampError,
  readManifestVersion,
  stampCrateVersion,
  stampManifestVersion,
  stampPackageVersion,
} from "./version-stamp.js";

export { WORKSPACE_FILENAME, WorkspaceConfigError, parseWorkspaceConfig } from "./workspace-config.js";
export type { WorkspaceConfig } from "./workspace-config.js";
