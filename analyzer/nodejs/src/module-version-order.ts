/** SemVer precedence for module versions — the single ordering rule shared by
 *  version reconciliation and by any host deciding whether an import is behind.
 *
 *  Pure and dependency-free (no `semver` package), so the analyzer stays
 *  browser-safe and the editor can reach the same rule the kernel-side analysis
 *  uses. A caller that cannot parse a version must not guess: an OCI digest, a
 *  moving tag like `latest`, and a malformed pin all come back `null` rather
 *  than being ordered by some weaker fallback. */

export interface ParsedModuleVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers, or `null` for a release version. */
  pre: string[] | null;
}

/** Parse `X.Y.Z`, `vX.Y.Z`, or `X.Y.Z-pre.1`. Returns `null` for anything that
 *  isn't a plain three-part numeric core — an unparseable version is never
 *  silently ordered. */
export function parseModuleVersion(raw: string | undefined): ParsedModuleVersion | null {
  if (typeof raw !== "string") return null;
  const v = raw.startsWith("v") ? raw.slice(1) : raw;
  const [core, ...preParts] = v.split("-");
  const pre = preParts.length > 0 ? preParts.join("-") : null;
  const segments = core.split(".");
  if (segments.length !== 3) return null;
  const [major, minor, patch] = segments.map((s) => {
    if (!/^\d+$/.test(s)) return NaN;
    return Number(s);
  });
  if ([major, minor, patch].some((n) => Number.isNaN(n))) return null;
  return { major, minor, patch, pre: pre === null ? null : pre.split(".") };
}

/** SemVer precedence: numeric core, then a release outranks a prerelease, then
 *  prerelease identifiers compared field-by-field (numeric < non-numeric per
 *  spec, shorter set loses when all shared fields are equal). */
export function compareParsedModuleVersions(
  a: ParsedModuleVersion,
  b: ParsedModuleVersion,
): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === null && b.pre === null) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  const len = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i++) {
    const ai = a.pre[i];
    const bi = b.pre[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      const d = Number(ai) - Number(bi);
      if (d !== 0) return d;
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/** Negative / zero / positive when both versions parse, `null` when either does
 *  not. The string-in convenience over {@link compareParsedModuleVersions}. */
export function compareModuleVersions(a: string, b: string): number | null {
  const left = parseModuleVersion(a);
  const right = parseModuleVersion(b);
  if (!left || !right) return null;
  return compareParsedModuleVersions(left, right);
}

/** True when `candidate` is strictly newer than `current` — the test for
 *  whether an import is behind. False when they are equal, when `current` is
 *  ahead (a version index can lag the module's own origin, and "upgrading" to
 *  what it knows would be a downgrade), or when either side is unparseable. */
export function isNewerModuleVersion(candidate: string, current: string): boolean {
  return (compareModuleVersions(candidate, current) ?? 0) > 0;
}

/** True when two tags name the same version, tolerating a `v` prefix on either
 *  side. Falls back to exact equality for unparseable tags, so a digest still
 *  matches itself. */
export function isSameModuleVersion(a: string, b: string): boolean {
  return a === b || compareModuleVersions(a, b) === 0;
}
