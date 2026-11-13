/**
 * The two vocabularies a release speaks, and the arithmetic between them.
 *
 * A **kind** is what an author writes in a fragment (`Added`, `Fixed`, …): it
 * decides both the semantic level of the bump and the heading the entry lands
 * under in the changelog. A **level** is what the version arithmetic consumes.
 * The mapping is total: an unrecognized kind is refused rather than defaulted,
 * because a typo degrading to `patch` would under-release a breaking change.
 */

/** Semantic level of a version move. */
export type BumpLevel = "major" | "minor" | "patch";

export const BUMP_LEVELS: readonly BumpLevel[] = ["patch", "minor", "major"];

/** Several levels reaching one unit join as the maximum: a unit shipping a
 *  breaking change is breaking for its own consumers. */
const LEVEL_RANK: Record<BumpLevel, number> = { patch: 0, minor: 1, major: 2 };

export function isBumpLevel(value: unknown): value is BumpLevel {
  return typeof value === "string" && value in LEVEL_RANK;
}

export function maxLevel(a: BumpLevel, b: BumpLevel): BumpLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

/** Whether `level` is above `ceiling`. */
export function levelExceeds(level: BumpLevel, ceiling: BumpLevel): boolean {
  return LEVEL_RANK[level] > LEVEL_RANK[ceiling];
}

/** Fragment kinds, in changelog section order, each with the level it induces. */
export const FRAGMENT_KINDS = {
  Added: "minor",
  Changed: "major",
  Deprecated: "minor",
  Removed: "major",
  Fixed: "patch",
  Security: "patch",
} as const satisfies Record<string, BumpLevel>;

export type FragmentKind = keyof typeof FRAGMENT_KINDS;

/** Declaration order, which is also the order sections appear in a changelog
 *  release block. */
export const FRAGMENT_KIND_ORDER: readonly FragmentKind[] = Object.keys(
  FRAGMENT_KINDS,
) as FragmentKind[];

export function isFragmentKind(value: unknown): value is FragmentKind {
  return typeof value === "string" && value in FRAGMENT_KINDS;
}

export function levelOfKind(kind: FragmentKind): BumpLevel {
  return FRAGMENT_KINDS[kind];
}

/** A final `major.minor.patch` version. */
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** A candidate of a final: `<final>-<id>.<k>`, `id` an identifier, `k` from 1. */
const CANDIDATE = /^(\d+\.\d+\.\d+)-([A-Za-z][A-Za-z0-9]*)\.([1-9]\d*)$/;

export function isReleaseVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value);
}

export interface CandidateVersion {
  readonly final: string;
  readonly id: string;
  readonly k: number;
}

export function parseCandidateVersion(value: string): CandidateVersion | undefined {
  const match = CANDIDATE.exec(value);
  return match ? { final: match[1]!, id: match[2]!, k: Number(match[3]) } : undefined;
}

/** A final version or a candidate of one — every version a unit may carry. */
export function isUnitVersion(value: unknown): value is string {
  return isReleaseVersion(value) || (typeof value === "string" && CANDIDATE.test(value));
}

/** Whether `value` names a candidate identifier `apply --candidate` accepts. */
export function isCandidateId(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*$/.test(value);
}

export function candidateVersion(final: string, id: string, k: number): string {
  return `${final}-${id}.${k}`;
}

/** Apply `level` to a final `version`. Throws on a version this system cannot
 *  represent, rather than returning something plausible. */
export function applyBump(version: string, level: BumpLevel): string {
  const match = VERSION.exec(version);
  if (!match) {
    throw new Error(
      `'${version}' is not a major.minor.patch version, so no ${level} bump can be derived from it.`,
    );
  }
  const [major, minor, patch] = match.slice(1, 4).map(Number) as [number, number, number];
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Numeric comparison of final versions, so `0.10.0` sorts after `0.9.0`. An
 *  unparseable version sorts last rather than throwing. */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION.exec(a);
  const pb = VERSION.exec(b);
  if (!pa || !pb) return pa ? -1 : pb ? 1 : a.localeCompare(b);
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}
