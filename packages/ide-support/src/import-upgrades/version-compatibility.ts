import {
  TELO_SURFACE_VERSION,
  compareModuleVersions,
  isNewerModuleVersion,
  manifestCompatibility,
  parseModuleVersion,
  type ModuleCompatibility,
} from "@telorun/analyzer";
import type { ModuleVersion } from "./build-import-upgrades.js";

export type { ModuleCompatibility };

/**
 * Host capability: the `telo.yaml` text of one version of a module, or `null`
 * when this host cannot address it (a transport it does not speak, a ref with
 * no version segment). Rejecting is equally fine — both read as "not known",
 * never as "incompatible".
 *
 * Narrow on purpose, and separate from {@link ModuleVersionLookup}: enumerating
 * versions and reading one manifest are different routes with different costs,
 * and a host caches or throttles them differently.
 */
export type ModuleManifestReader = (
  baseRef: string,
  version: string,
) => Promise<string | null | undefined>;

/** The question an upgrade asks of a candidate version. */
export type VersionCompatibilityCheck = (
  baseRef: string,
  version: string,
) => Promise<ModuleCompatibility>;

/**
 * A compatibility check backed by `read`, memoized per module and version for
 * the lifetime of the returned function.
 *
 * The cache is not an optimization detail — an IDE re-derives its upgrade
 * affordances on every keystroke, and a published version's declared
 * requirement is immutable, so refetching it would be pure waste against an
 * answer that cannot have changed. In-flight promises are shared, so the
 * concurrent lookups one file's imports produce collapse to one read each.
 *
 * The verdict is always the analyzer's {@link manifestCompatibility}: an IDE
 * reports NO host versions, because it is not the machine that will run the
 * manifest. Only the telo surface is checked here; a host requirement still
 * surfaces at the load gate when the manifest is actually run.
 */
export function createVersionCompatibility(
  read: ModuleManifestReader,
  teloVersion: string = TELO_SURFACE_VERSION,
): VersionCompatibilityCheck {
  const cache = new Map<string, Promise<ModuleCompatibility>>();
  return (baseRef, version) => {
    const key = `${baseRef}@${version}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = read(baseRef, version)
      .then((text) => (text ? manifestCompatibility(text, teloVersion) : "unknown"))
      .catch(() => "unknown" as const);
    cache.set(key, pending);
    // Only a DECIDED verdict is kept. What is immutable is a published version's
    // declared requirement, not the network: caching `unknown` would let one
    // offline moment disable the check for the rest of the session, leaving the
    // UI reading as though every version had been checked and cleared. Dropped
    // after it settles rather than before, so concurrent asks still share the
    // one in-flight read.
    void pending.then((verdict) => {
      if (verdict === "unknown" && cache.get(key) === pending) cache.delete(key);
    });
    return pending;
  };
}

/** A check that answers `unknown` for everything — the honest reading for a
 *  host with no way to fetch a candidate manifest. Never blocks an upgrade. */
export const uncheckedVersionCompatibility: VersionCompatibilityCheck = async () => "unknown";

/** Why a candidate was not offered. `unknown` never appears: a version that
 *  could not be read is offered, since an unreachable source must not silently
 *  freeze an author's imports. */
export type IncompatibilityReason = Exclude<ModuleCompatibility, "yes" | "unknown">;

export interface VersionSelection {
  /** The newest version this runtime can host that is also newer than the
   *  current one, or `null` when there is none. */
  best: ModuleVersion | null;
  /** The newest candidate overall, when it is NOT `best` — what was held back.
   *  Reported rather than swallowed: without it an upgrade affordance says
   *  "up to date" while newer versions exist, which is a silent ceiling and a
   *  worse report than the load failure this whole check replaces. */
  heldBack: { version: string; reason: IncompatibilityReason } | null;
}

/**
 * The newest version whose declared requirement accepts this runtime, among
 * those newer than `currentVersion`.
 *
 * Walks newest-first and stops at the first satisfied candidate, so the common
 * case — the newest version is compatible — costs a single manifest read.
 * Candidates older than the current version are never considered: an upgrade
 * that walks backwards is a downgrade nobody asked for. Pass `null` for an
 * import that does not exist yet, where every published version is a candidate
 * and there is nothing to walk backwards from.
 */
export async function selectCompatibleVersion(
  baseRef: string,
  versions: readonly ModuleVersion[],
  currentVersion: string | null,
  isCompatible: VersionCompatibilityCheck,
  options: { includePrerelease?: boolean } = {},
): Promise<VersionSelection> {
  const candidates = upgradeCandidates(versions, currentVersion, options);
  if (candidates.length === 0) return { best: null, heldBack: null };

  const newest = candidates[0]!;
  let firstReason: IncompatibilityReason | null = null;
  for (const candidate of candidates) {
    const verdict = await isCompatible(baseRef, candidate.version);
    if (verdict === "too-new" || verdict === "unreadable") {
      firstReason ??= verdict;
      continue;
    }
    const held = candidate === newest ? null : { version: newest.version, reason: firstReason! };
    return { best: candidate, heldBack: held };
  }
  return { best: null, heldBack: { version: newest.version, reason: firstReason! } };
}

/** One version as a picker renders it: what it is, and what this runtime makes
 *  of it. */
export interface MarkedVersion extends ModuleVersion {
  compatibility: ModuleCompatibility;
}

/**
 * Every version, each carrying its own verdict — what a deliberate pick needs.
 *
 * Unlike {@link selectCompatibleVersion} this cannot short-circuit: a picker
 * marks entries it is not going to choose, so every entry has to be asked. That
 * is why the two are separate operations rather than one with a flag — the
 * automatic path must stay one read, and the picker is an explicit action on a
 * single import whose reads are cached from then on.
 */
export async function markVersionCompatibility(
  baseRef: string,
  versions: readonly ModuleVersion[],
  isCompatible: VersionCompatibilityCheck,
): Promise<MarkedVersion[]> {
  return Promise.all(
    versions.map(async (version) => ({
      ...version,
      compatibility: await isCompatible(baseRef, version.version),
    })),
  );
}

/**
 * Why nothing in a marked list can be offered, or `null` when something can.
 *
 * A picker has to state this outright: a list where every row is marked
 * explains nothing on its own, and the reader is left thinking the tool is
 * broken. A reason rather than a boolean because the two rejections have
 * different remedies — see {@link describeRemedy}. `unknown` counts as
 * offerable: a version this host could not check is not one it may refuse.
 */
export function noneRunnableReason(
  versions: readonly MarkedVersion[],
): IncompatibilityReason | null {
  if (versions.length === 0) return null;
  if (versions.some((v) => v.compatibility === "yes" || v.compatibility === "unknown")) {
    return null;
  }
  // The newest blocked version's reason, in the list's own (newest-first)
  // order: it is the one the reader is asking about.
  return versions[0]!.compatibility as IncompatibilityReason;
}

/** Candidates strictly newer than `currentVersion`, newest first.
 *
 *  Ordering and prerelease exclusion come from the analyzer's shared rule, so
 *  "is this import behind" and "what would it move to" cannot disagree. */
function upgradeCandidates(
  versions: readonly ModuleVersion[],
  currentVersion: string | null,
  options: { includePrerelease?: boolean },
): ModuleVersion[] {
  return versions
    .filter((v) => {
      const parsed = parseModuleVersion(v.version);
      if (parsed === null) return false;
      if (parsed.pre !== null && !options.includePrerelease) return false;
      return currentVersion === null || isNewerModuleVersion(v.version, currentVersion);
    })
    .sort((a, b) => compareModuleVersions(b.version, a.version) ?? 0);
}
