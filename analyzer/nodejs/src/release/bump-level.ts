/**
 * The two vocabularies a release speaks, and the arithmetic between them.
 *
 * A **kind** is what an author writes in a fragment (`Added`, `Fixed`, …). It is
 * changie's vocabulary, kept because it drives two things at once: the semantic
 * level of the bump, and the heading the entry lands under in the changelog. A
 * **level** is what the version arithmetic consumes.
 *
 * The mapping is the only place the two meet, and it is deliberately total: an
 * unrecognized kind is refused rather than defaulted, because a typo that
 * degraded to `patch` would silently under-release a breaking change.
 */

/** Semantic level of a version move. */
export type BumpLevel = "major" | "minor" | "patch";

/** Ordering used whenever several levels reach one module — the maximum wins,
 *  because a module that inlines a breaking change is breaking for its own
 *  consumers. */
const LEVEL_RANK: Record<BumpLevel, number> = { patch: 0, minor: 1, major: 2 };

export function maxLevel(a: BumpLevel, b: BumpLevel): BumpLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

/**
 * Fragment kinds, in changelog section order, each with the level it induces.
 *
 * `Changed` / `Removed` induce `major`, which the pre-1.0 guard then rejects —
 * they are kept in the vocabulary rather than dropped so the rejection can name
 * what was written and say why, instead of reporting an unknown kind.
 */
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

/** A `major.minor.patch` triple. Pre-release and build metadata are not accepted:
 *  a module version is the tag an artifact publishes under and the value a pin
 *  resolves, and neither has a meaning for a suffix today. */
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

export function isReleaseVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value);
}

/** Apply `level` to `version`. Throws on a version this system cannot represent,
 *  rather than returning something plausible — every caller has already read the
 *  value out of a manifest it is about to rewrite. */
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

/** Numeric comparison, so `0.10.0` sorts after `0.9.0`. Returns a negative
 *  number when `a` precedes `b`. An unparseable version sorts last rather than
 *  throwing — this is used for display ordering, not for decisions. */
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
