/**
 * `@telorun/release/node` — the Node half: evidence (git reads, the ledger
 * store, carried changes, layer file sets, edges, read-back), the evidence
 * halves of the shipped `npm`, `cargo`, `docker` and `helm` ecosystems, and the
 * release command tree a host mounts.
 */

export { carriedBy, releasedBy } from "./carried-changes.js";
export type { CarriedQuery } from "./carried-changes.js";
export { changedFilesSinceBase, fileAt } from "./git.js";
export { digestFileSet, listFiles, readFileSetEntry } from "./files-digest.js";
export type { FileSetEntry } from "./files-digest.js";
export { readTarGz, stripPrefix } from "./tar.js";
export { PENDING_DIR, deleteFragment, readFragments, readLedger, writeFragment, writeLedger } from "./ledger-store.js";
export {
  WorkspaceNotFoundError,
  directoriesUnder,
  findWorkspaceRoot,
  loadReleaseWorkspace,
  readWorkspaceFile,
  workspaceTree,
} from "./workspace.js";
export type { LoadOptions, MarkerRead, ReleaseWorkspace } from "./workspace.js";
export {
  collectEvidence,
  destinationDiagnostics,
  openSessions,
  owningUnit,
  publishes,
  sessionOf,
  unitEvidence,
} from "./evidence.js";
export type {
  AnchorEvidence,
  AnchorRef,
  CollectOptions,
  EvidenceAdapter,
  EvidenceSession,
  ReadBack,
  SessionOptions,
  Sessions,
} from "./evidence.js";
export { PayloadError, declaredPayload } from "./declared-payload.js";
export { metafileInlines } from "./metafile.js";
export { RegistryError, fetchBytes, fetchOrAbsent } from "./registry-fetch.js";
export { dockerignorePatterns } from "./adapters/dockerignore-patterns.js";
export { detectPackageManager, type PackageManager } from "./adapters/package-manager.js";
export { npmEvidence } from "./adapters/npm-evidence.js";
export { cargoEvidence } from "./adapters/cargo-evidence.js";
export { dockerContext, dockerDestination, dockerEvidence, dockerFileSet } from "./adapters/docker-evidence.js";
export { helmEvidence } from "./adapters/helm-evidence.js";
export {
  applyPlan,
  candidateId,
  createTags,
  loadWorkspaceFor,
  orderRows,
  pendingFragments,
  planWorkspaceRelease,
  recordedLedger,
  tagsToCreate,
  upfrontDiagnostics,
  verifyLedger,
} from "./operations.js";
export type { Applied, OrderRow, PlanOptions, PlanRun, VerifyFinding } from "./operations.js";
export { describeReason, planPayload, renderDiagnostics, renderPlan } from "./render.js";
export { adoptChangesets } from "./adopt-changesets.js";
export type { AdoptResult } from "./adopt-changesets.js";
export { fragmentFilename, guardWith, releaseCommands, requireUnit } from "./commands.js";
export type { Guard, ReleaseHost, ReleaseOutput, Style } from "./host.js";

import { cargoEvidence } from "./adapters/cargo-evidence.js";
import { dockerEvidence } from "./adapters/docker-evidence.js";
import { helmEvidence } from "./adapters/helm-evidence.js";
import { npmEvidence } from "./adapters/npm-evidence.js";
import type { EvidenceAdapter } from "./evidence.js";

/** The evidence halves of the ecosystems this package ships. */
export const SHIPPED_EVIDENCE: readonly EvidenceAdapter[] = [npmEvidence, cargoEvidence, dockerEvidence, helmEvidence];
