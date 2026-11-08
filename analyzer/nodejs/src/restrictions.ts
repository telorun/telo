/**
 * The single reader of a module doc's `restrictions:` list — what an author
 * knows about a version's runtime range that measuring its floor cannot see: a
 * ceiling found after publish, a floor no static check reveals, a Node bound.
 *
 * ```yaml
 * restrictions:
 *   - versions: ">=1.2.0"
 *     requires: { telo: "<0.122.0" }
 *     reason: Lookup never returns on telo 0.122.0 and later.
 * ```
 *
 * **A version speaks for itself and earlier ones, never for a later one.** An
 * entry without `versions` covers only the declaring doc; with `versions` it
 * covers the module versions the range admits up to the declaring doc's own
 * `metadata.version`, so a range with no upper bound runs through this version
 * whatever the module track later makes it, and an upper bound above this
 * version is refused. `requires` has the top-level block's shape, but `telo` may
 * be bounded from above here.
 *
 * Lenient like `readRequires`: never throws, and a malformed entry is reported
 * and left out of `entries`, so nothing enforces a requirement its author failed
 * to state. Whether the entries leave a version usable at all is a question of
 * the whole range, answered by `validate-requires.ts`. Browser-safe.
 */

import { compareModuleVersions, parseModuleVersion } from "./module-version-order.js";
import { readRequirementMap, type RequiresBlock, type RequiresIssue } from "./requires-block.js";
import { parseVersionRange, rangeAccepts, upperBound, type VersionRange } from "./version-range.js";

export interface Restriction {
  /** The entry's position in the list, which names it: `restrictions[<index>]`. */
  index: number;
  /** The module versions covered, as written; absent covers only the declaring doc. */
  versions?: VersionRange;
  requires: RequiresBlock;
  reason: string;
}

export interface ReadRestrictionsResult {
  /** True whenever the doc carries a `restrictions:` key, even a malformed one. */
  declared: boolean;
  /** The well-formed entries, in list order. */
  entries: Restriction[];
  issues: RequiresIssue[];
}

const ENTRY_KEYS = ["versions", "requires", "reason"] as const;

/** Read the list off a module doc, closing each `versions` range at the doc's
 *  own `metadata.version`. */
export function readRestrictions(doc: Record<string, unknown> | undefined): ReadRestrictionsResult {
  const raw = doc?.restrictions;
  if (raw === undefined) return { declared: false, entries: [], issues: [] };
  const issues: RequiresIssue[] = [];
  if (!Array.isArray(raw)) {
    issues.push({
      path: "restrictions",
      message: `'restrictions' must be a list of entries, got ${describe(raw)}.`,
    });
    return { declared: true, entries: [], issues };
  }

  const declaring = declaringVersion(doc);
  const entries: Restriction[] = [];
  raw.forEach((item, index) => {
    const entry = readEntry(item, index, declaring);
    issues.push(...entry.issues);
    if (entry.restriction) entries.push(entry.restriction);
  });
  return { declared: true, entries, issues };
}

function readEntry(
  item: unknown,
  index: number,
  declaring: string | undefined,
): { restriction?: Restriction; issues: RequiresIssue[] } {
  const path = `restrictions[${index}]`;
  const issues: RequiresIssue[] = [];
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    issues.push({
      path,
      message: `${path} must be a mapping of ${ENTRY_KEYS.map((k) => `'${k}'`).join(", ")}, got ${describe(item)}.`,
    });
    return { issues };
  }
  const entry = item as Record<string, unknown>;

  for (const key of Object.keys(entry)) {
    if (!(ENTRY_KEYS as readonly string[]).includes(key)) {
      issues.push({
        path: `${path}.${key}`,
        message:
          `'${path}.${key}' is not a restriction key; an entry holds ` +
          `${ENTRY_KEYS.map((k) => `'${k}'`).join(", ")}.`,
      });
    }
  }

  let versions: VersionRange | undefined;
  if (entry.versions !== undefined) {
    const at = `${path}.versions`;
    const parsed = parseVersionRange(entry.versions);
    if (!parsed.ok) {
      issues.push({ path: at, message: `'${at}': ${parsed.error.message}.`, hint: parsed.error.hint });
    } else if (declaring === undefined) {
      issues.push({
        path: at,
        message:
          `${at} needs this module's metadata.version as a three-part version, which closes ` +
          `the range at this version.`,
      });
    } else {
      const upper = upperBound(parsed.range);
      if (upper && (compareModuleVersions(upper.raw, declaring) ?? 0) > 0) {
        issues.push({
          path: at,
          message:
            `${at} '${parsed.range.raw}' reaches past this module's version ${declaring}; an ` +
            `entry covers only this version and earlier ones. Leave the upper bound off to ` +
            `cover through this version.`,
        });
      } else {
        versions = parsed.range;
      }
    }
  }

  let requires: RequiresBlock | undefined;
  if (entry.requires === undefined) {
    issues.push({
      path,
      message: `${path} has no requires; name the runtime range the covered versions are restricted to.`,
    });
  } else {
    const at = `${path}.requires`;
    const read = readRequirementMap(entry.requires, at, "restriction");
    issues.push(...read.issues);
    if (read.issues.length === 0) {
      if (read.block.telo === undefined && Object.keys(read.block.host).length === 0) {
        issues.push({ path: at, message: `${at} states no bound.` });
      } else {
        requires = read.block;
      }
    }
  }

  const reason = entry.reason;
  if (typeof reason !== "string" || reason.trim() === "") {
    issues.push({
      path,
      message: `${path} has no reason; say what breaks, so whoever is held back knows why.`,
    });
  }

  if (issues.length > 0 || !requires || typeof reason !== "string") return { issues };
  return {
    restriction: { index, ...(versions ? { versions } : {}), requires, reason: reason.trim() },
    issues,
  };
}

/**
 * Whether `entry`, declared by the doc at `declaring`, covers `version`. Without
 * `versions` it covers only the declaring doc itself; with `versions`, every
 * version the range admits that is not later than the declaring one.
 */
export function restrictionCovers(
  entry: Restriction,
  declaring: string | undefined,
  version: string | undefined,
): boolean {
  if (!entry.versions) {
    if (version === declaring) return true;
    return version !== undefined && declaring !== undefined && compareModuleVersions(version, declaring) === 0;
  }
  if (version === undefined || declaring === undefined) return false;
  const order = compareModuleVersions(version, declaring);
  return order !== null && order <= 0 && rangeAccepts(entry.versions, version);
}

/** The doc's own `metadata.version`, when it is one a range can be closed at. */
export function declaringVersion(doc: Record<string, unknown> | undefined): string | undefined {
  const version = (doc?.metadata as Record<string, unknown> | undefined)?.version;
  return typeof version === "string" && parseModuleVersion(version) ? version : undefined;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
