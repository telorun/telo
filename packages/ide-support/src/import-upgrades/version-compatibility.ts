import {
  TELO_RUNNING_SURFACE,
  compareModuleVersions,
  isNewerModuleVersion,
  parseModuleVersion,
  readModuleVersion,
  selectionCompatibility,
  type ModuleCompatibility,
  type ModuleVersionRequirements,
  type SelectionVerdict,
} from "@telorun/analyzer";
import type { ModuleVersion } from "./build-import-upgrades.js";

export type { ModuleCompatibility, SelectionVerdict };

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

/**
 * The question an upgrade asks of a candidate version. `published` lists the
 * module's published versions: a verdict is not a function of the candidate's
 * manifest alone, since a newer version's `restrictions:` entry may hold it
 * back, so the check reads every version newer than the candidate (and none
 * older). Omitted, no version speaks for the candidate.
 */
export type VersionCompatibilityCheck = (
  baseRef: string,
  version: string,
  published?: readonly string[],
) => Promise<SelectionVerdict>;

/**
 * A compatibility check backed by `read`, memoized per module and version for
 * the lifetime of the returned function.
 *
 * The cache is not an optimization detail — an IDE re-derives its upgrade
 * affordances on every keystroke, and a published version's declared
 * requirement is immutable, so refetching it would be pure waste against an
 * answer that cannot have changed. In-flight promises are shared, so the
 * concurrent lookups one file's imports produce collapse to one read each, and
 * a version read as a candidate is the same read when a later candidate needs
 * it as a newer version.
 *
 * The verdict is the analyzer's {@link selectionCompatibility}: an IDE reports
 * NO host versions, because it is not the machine that will run the manifest.
 * Only the telo surface is checked here; a host requirement still surfaces at
 * the load gate when the manifest is actually run.
 */
export function createVersionCompatibility(
  read: ModuleManifestReader,
  teloVersion: string = TELO_RUNNING_SURFACE,
): VersionCompatibilityCheck {
  const cache = new Map<string, Promise<ModuleVersionRequirements>>();
  const requirementsOf = (baseRef: string, version: string): Promise<ModuleVersionRequirements> => {
    const key = `${baseRef}@${version}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = read(baseRef, version)
      .then((text) => (text ? readModuleVersion({ version, text }) : unknownVersion(version)))
      .catch(() => unknownVersion(version));
    cache.set(key, pending);
    // Only a DECIDED reading is kept. What is immutable is a published version's
    // declared requirement, not the network: caching `unknown` would let one
    // offline moment disable the check for the rest of the session, leaving the
    // UI reading as though every version had been checked and cleared. Dropped
    // after it settles rather than before, so concurrent asks still share the
    // one in-flight read.
    void pending.then((reading) => {
      if (reading.requirements === "unknown" && cache.get(key) === pending) cache.delete(key);
    });
    return pending;
  };
  return async (baseRef, version, published = []) => {
    const candidate = await requirementsOf(baseRef, version);
    if (candidate.requirements === "unknown") return { compatibility: "unknown" };
    const newer = await Promise.all(
      published
        .filter((v) => (compareModuleVersions(v, version) ?? 0) > 0)
        .map((v) => requirementsOf(baseRef, v)),
    );
    return selectionCompatibility(candidate, newer, teloVersion);
  };
}

function unknownVersion(version: string): ModuleVersionRequirements {
  return { version, requirements: "unknown" };
}

/** A check that answers `unknown` for everything — the honest reading for a
 *  host with no way to fetch a candidate manifest. Never blocks an upgrade. */
export const uncheckedVersionCompatibility: VersionCompatibilityCheck = async () => ({
  compatibility: "unknown",
});

/** Why a candidate was not offered. `unknown` never appears: a version that
 *  could not be read is offered, since an unreachable source must not silently
 *  freeze an author's imports. */
export type IncompatibilityReason = Exclude<
  SelectionVerdict["compatibility"],
  "yes" | "unknown"
>;

/** A version held back, with the sentence naming what held it. */
export interface HeldBack {
  version: string;
  reason: IncompatibilityReason;
  /** The bound and, for a `restrictions:` entry, its reason and the version
   *  declaring it. Absent for an unreadable requirement. */
  detail?: string;
}

export interface VersionSelection {
  /** The newest version this runtime can host that is also newer than the
   *  current one, or `null` when there is none. */
  best: ModuleVersion | null;
  /** The newest candidate overall, when it is NOT `best` — what was held back.
   *  Reported rather than swallowed: without it an upgrade affordance says
   *  "up to date" while newer versions exist, which is a silent ceiling and a
   *  worse report than the load failure this whole check replaces. */
  heldBack: HeldBack | null;
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

  const published = versions.map((v) => v.version);
  const newest = candidates[0]!;
  let first: HeldBack | null = null;
  for (const candidate of candidates) {
    const verdict = await isCompatible(baseRef, candidate.version, published);
    if (verdict.compatibility === "yes" || verdict.compatibility === "unknown") {
      return { best: candidate, heldBack: candidate === newest ? null : first };
    }
    first ??= { version: newest.version, reason: verdict.compatibility, ...heldDetail(verdict) };
  }
  return { best: null, heldBack: first };
}

/** One version as a picker renders it: what it is, and what this runtime makes
 *  of it. `detail` names what held it back when a bound did. */
export interface MarkedVersion extends ModuleVersion {
  compatibility: SelectionVerdict["compatibility"];
  detail?: string;
}

/** The sentence a bound-based verdict carries: the bound, the entry's reason
 *  and the version declaring it when that is not the held version itself. */
export function describeHold(verdict: SelectionVerdict): string | undefined {
  if (verdict.compatibility !== "too-new" && verdict.compatibility !== "too-old") return undefined;
  const bound = `${verdict.key === "telo" ? "telo" : `${verdict.key}`} '${verdict.bound}'`;
  const source = verdict.source;
  if (source.from === "requires") return `requires ${bound}; this runtime reports ${verdict.running}`;
  const by = source.version ? ` in ${source.version}` : "";
  return `restricted to ${bound} by an entry${by}: ${source.reason}`;
}

function heldDetail(verdict: SelectionVerdict): { detail?: string } {
  const detail = describeHold(verdict);
  return detail ? { detail } : {};
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
  const published = versions.map((v) => v.version);
  return Promise.all(
    versions.map(async (version) => {
      const verdict = await isCompatible(baseRef, version.version, published);
      const detail = describeHold(verdict);
      return { ...version, compatibility: verdict.compatibility, ...(detail ? { detail } : {}) };
    }),
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
