/**
 * `@telorun/release` — the release model, browser-safe: units and their anchors,
 * the `release:` block of `telo-workspace.yaml`, fragments, the ledger, the edge
 * graph, groups, version planning, candidates and changelogs, plus the pure
 * halves of the `npm`, `cargo`, `docker` and `helm` ecosystems.
 *
 * Pure data in, plan out. Reading a tree, building payloads and talking to a
 * registry are a host's — it hands this package file text and digests.
 */

export {
  BUMP_LEVELS,
  FRAGMENT_KINDS,
  FRAGMENT_KIND_ORDER,
  applyBump,
  candidateVersion,
  compareVersions,
  isBumpLevel,
  isCandidateId,
  isFragmentKind,
  isReleaseVersion,
  isUnitVersion,
  levelExceeds,
  levelOfKind,
  maxLevel,
  parseCandidateVersion,
} from "./bump-level.js";
export type { BumpLevel, CandidateVersion, FragmentKind } from "./bump-level.js";

export { AdapterRegistry, RESERVED_ECOSYSTEMS } from "./adapter.js";
export type {
  AnchorProbe,
  EcosystemAdapter,
  RecognizedPackage,
  VersionFileHandler,
  VersionLocationSpec,
} from "./adapter.js";

export { CHANGELOG_FILE, CHANGELOG_HEADER, prependChangelogRelease, renderChangelogRelease } from "./changelog.js";
export type { ChangelogRelease } from "./changelog.js";

export { FragmentError, normalizeUnitKey, parseFragment, serializeFragment } from "./fragment.js";
export type { ReleaseFragment, UnitKey } from "./fragment.js";

export {
  EMPTY_LAYERS,
  EMPTY_LEDGER,
  LEDGER_PATH,
  LedgerError,
  PAYLOAD_LAYER,
  diffLayers,
  layerDigests,
  parseLedger,
  serializeLedger,
} from "./ledger.js";
export type {
  AnchorDigest,
  CandidateRecord,
  LayerChange,
  Ledger,
  LedgerEntry,
  LegacyLedgerLayers,
  ParseLedgerOptions,
  UnitLayers,
} from "./ledger.js";

export {
  WORKSPACE_FILENAME,
  WorkspaceConfigError,
  diagnosticsFor,
  hasError,
  nearMiss,
  parseMarker,
  readBoolean,
  readEntries,
  readKnownKeys,
  readSchemaBlock,
  readString,
  readStringList,
  reportNullKeys,
  reportUnknownKeys,
} from "./marker-reader.js";
export type { MarkerReport, ReadEntry, WorkspaceDiagnostic, WorkspaceDiagnosticCode } from "./marker-reader.js";

export {
  DEFAULT_RELEASE_IGNORE,
  RELEASE_BLOCK_KEYS,
  UNIT_ENTRY_KEYS,
  releaseBlockSchema,
} from "./marker-schema.js";
export type { WorkspaceBlockSchema, WorkspaceEntrySchema, WorkspaceKeySchema } from "./marker-schema.js";

export {
  normalizeAnchor,
  readReleaseBlock,
  readReleaseMarker,
  requireReleaseSettings,
} from "./release-settings.js";
export type {
  PayloadSpec,
  ReadReleaseOptions,
  ReleaseMarkerRead,
  ReleaseSettings,
  UnitEntry,
  VersionFileSpec,
} from "./release-settings.js";

export {
  decidingEntry,
  joinPath,
  readUnitVersions,
  resolveUnits,
  stampUnitVersion,
} from "./units.js";
export type {
  ResolvedAnchor,
  ResolvedUnit,
  UnitResolution,
  VersionLocation,
  VersionReading,
  WorkspaceTree,
} from "./units.js";

export {
  VersionFileError,
  documentScalar,
  pointerTokens,
  readVersionAt,
  spliceScalar,
  spliceText,
  tomlString,
  writeVersionAt,
} from "./version-files.js";

export { judgeUnitVersions, orderByImports, planRelease, recordRelease } from "./release-plan.js";
export type {
  BumpReason,
  ChangelogEntry,
  PlanOptions,
  PlannedUnit,
  RecordedReading,
  ReleaseDiagnostic,
  ReleaseEvidence,
  ReleasePlan,
  UnitEvidence,
} from "./release-plan.js";

export { PACKAGE_JSON, npmAdapter, stampPackageVersion } from "./adapters/npm.js";
export {
  CARGO_LOCK,
  CARGO_TOML,
  cargoAdapter,
  governingLockfile,
  readCrateName,
  stampCrateVersion,
  stampLockedCrateVersion,
  stampPathDependencyRequirements,
} from "./adapters/cargo.js";
export { DOCKERFILE, dockerAdapter } from "./adapters/docker.js";
export { CHART_YAML, helmAdapter, stampChartVersion } from "./adapters/helm.js";

import { cargoAdapter } from "./adapters/cargo.js";
import { dockerAdapter } from "./adapters/docker.js";
import { helmAdapter } from "./adapters/helm.js";
import { npmAdapter } from "./adapters/npm.js";
import type { EcosystemAdapter } from "./adapter.js";

/** The adapters this package ships, for a host to register. */
export const SHIPPED_ADAPTERS: readonly EcosystemAdapter[] = [npmAdapter, cargoAdapter, dockerAdapter, helmAdapter];
