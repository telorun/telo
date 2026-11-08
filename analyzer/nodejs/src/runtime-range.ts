/**
 * The runtime range of one module version — the one effective-range function
 * the load gate, `telo upgrade` and the editors share, over the readers of
 * `requires:` (`requires-block.ts`) and `restrictions:` (`restrictions.ts`).
 *
 * **At load** a version's range is its own `requires` narrowed by its own
 * entries that cover it: only the pinned version's own bytes, so a pinned run
 * stays deterministic and offline, and a restriction a later version adds never
 * breaks an installed pin.
 *
 * **At selection** a candidate's range is its load range narrowed, per
 * requirement key, by the covering entries on that key of the newest published
 * version newer than the candidate that has any entry covering it and stating
 * that key — a release when one speaks, a prerelease only when none does.
 * Omitting an entry lifts nothing, since an older statement still speaks;
 * lifting is restating the key from a newer version. A version's own entries
 * always apply to it.
 *
 * Every constraint carries where it came from, so a refusal names the entry and
 * the reason whoever is held back is shown. Browser-safe.
 */

import { compareModuleVersions, parseModuleVersion } from "./module-version-order.js";
import {
  KNOWN_HOST_AXES,
  readRequires,
  type HostAxis,
  type HostVersions,
  type ReadRequiresResult,
  type RequiresBlock,
} from "./requires-block.js";
import {
  declaringVersion,
  readRestrictions,
  restrictionCovers,
  type ReadRestrictionsResult,
  type Restriction,
} from "./restrictions.js";
import {
  isUnsatisfiable,
  rangeAccepts,
  splitBuildMetadata,
  type VersionComparator,
  type VersionRange,
} from "./version-range.js";

/** A requirement key: the telo surface, or a host axis. */
export type RequirementKey = "telo" | HostAxis;

/** Every key, in the order a range is judged: `telo` first, for the reason
 *  `requires-block.ts` gives. */
export const REQUIREMENT_KEYS: readonly RequirementKey[] = ["telo", ...KNOWN_HOST_AXES];

/** Where a constraint was stated. */
export type RequirementSource =
  /** The version's own `requires:` block. */
  | { from: "requires" }
  /** A `restrictions:` entry of the version `version` (the candidate's own at
   *  load; at selection possibly a newer one's). */
  | { from: "restriction"; version: string | undefined; index: number; reason: string };

export interface RangeConstraint {
  key: RequirementKey;
  range: VersionRange;
  source: RequirementSource;
}

/** One module version's runtime requirements, as its own doc states them. */
export interface ModuleRequirements {
  /** The doc's `metadata.version`, else the version its caller addressed it by. */
  version: string | undefined;
  requires: ReadRequiresResult;
  restrictions: ReadRestrictionsResult;
}

/** Read the requirements off a module doc. `addressedAs` names the version when
 *  the doc carries no `metadata.version` of its own. */
export function readModuleRequirements(
  doc: Record<string, unknown> | undefined,
  addressedAs?: string,
): ModuleRequirements {
  return {
    version: declaringVersion(doc) ?? addressedAs,
    requires: readRequires(doc),
    restrictions: readRestrictions(doc),
  };
}

export interface LoadRangeOptions {
  /** False to leave out the upper bound of the version's own `requires.telo` —
   *  refused in a module's own source, so not enforced beside its refusal. */
  ownCeiling?: boolean;
}

/** The version's load range: its own `requires` and its own covering entries. */
export function loadRange(module: ModuleRequirements, options: LoadRangeOptions = {}): RangeConstraint[] {
  const out = blockConstraints(module.requires.block, { from: "requires" }, options.ownCeiling !== false);
  for (const entry of module.restrictions.entries) {
    if (!restrictionCovers(entry, module.version, module.version)) continue;
    out.push(...entryConstraints(entry, module.version));
  }
  return out;
}

/** The candidate's selection range: its load range narrowed by what the newest
 *  speaking newer version says about it, key by key. `newer` may hold any
 *  published versions; only those newer than the candidate are read. */
export function selectionRange(
  candidate: ModuleRequirements,
  newer: readonly ModuleRequirements[],
): RangeConstraint[] {
  const out = loadRange(candidate);
  const target = candidate.version;
  if (target === undefined) return out;
  const later = newer.filter((m) => m.version !== undefined && (compareModuleVersions(m.version, target) ?? 0) > 0);
  for (const key of REQUIREMENT_KEYS) {
    const speaking = later
      .map((m) => ({
        module: m,
        entries: m.restrictions.entries.filter(
          (e) => restrictionCovers(e, m.version, target) && rangeOf(e.requires, key) !== undefined,
        ),
      }))
      .filter((s) => s.entries.length > 0);
    const releases = speaking.filter((s) => parseModuleVersion(s.module.version)?.pre === null);
    const speaker = newest(releases.length > 0 ? releases : speaking);
    if (!speaker) continue;
    for (const entry of speaker.entries) {
      out.push({ key, range: rangeOf(entry.requires, key)!, source: restrictionSource(entry, speaker.module.version) });
    }
  }
  return out;
}

/** What a runtime concluded about a range. */
export type RangeVerdict =
  | { satisfied: true }
  | {
      satisfied: false;
      /** `newer`: the runtime is below a floor; `older`: above a ceiling. */
      direction: "newer" | "older";
      key: RequirementKey;
      /** The bound it failed, as written: `>=0.121.0`, `<0.122.0`, `>=unreleased`. */
      bound: string;
      /** The failed comparator; absent for `>=unreleased`. */
      comparator?: VersionComparator;
      running: string;
      source: RequirementSource;
    };

/**
 * Judge a range against a runtime: `telo` first, then each host axis; on each,
 * every floor before any ceiling. A key whose running version is not supplied,
 * or cannot be parsed, is not judged — a runtime that cannot name its version
 * must not refuse modules on a number it could not read. `teloVersion` carries
 * `+unreleased` on a build of the pending release, which is what meets
 * `>=unreleased`.
 */
export function evaluateRange(
  constraints: readonly RangeConstraint[],
  teloVersion: string | undefined,
  host: HostVersions = {},
): RangeVerdict {
  for (const key of REQUIREMENT_KEYS) {
    const running = key === "telo" ? teloVersion : host[key];
    if (!running) continue;
    const { core, unreleased } = splitBuildMetadata(running);
    const parsed = parseModuleVersion(core);
    if (!parsed) continue;
    const onKey = constraints.filter((c) => c.key === key);
    for (const c of onKey) {
      if (c.range.unreleased && !unreleased) {
        return { satisfied: false, direction: "newer", key, bound: c.range.raw, running, source: c.source };
      }
      const floor = c.range.comparators.find((cmp) => (cmp.operator === ">=" || cmp.operator === ">") && !holds(cmp, core));
      if (floor) return failed("newer", key, floor, running, c.source);
    }
    for (const c of onKey) {
      const ceiling = c.range.comparators.find((cmp) => (cmp.operator === "<=" || cmp.operator === "<") && !holds(cmp, core));
      if (ceiling) return failed("older", key, ceiling, running, c.source);
    }
  }
  return { satisfied: true };
}

/** True when some version meets every range at once. `>=unreleased` lies above
 *  every published release, so it meets no ceiling, which must name one. */
export function rangesOverlap(ranges: readonly VersionRange[]): boolean {
  const comparators = ranges.flatMap((r) => r.comparators);
  if (ranges.some((r) => r.unreleased) && comparators.some((c) => c.operator === "<" || c.operator === "<=")) {
    return false;
  }
  if (comparators.length === 0) return true;
  return !isUnsatisfiable({ raw: "", comparators });
}

/** The range of `block` on `key`. */
export function rangeOf(block: RequiresBlock, key: RequirementKey): VersionRange | undefined {
  return key === "telo" ? block.telo : block.host[key];
}

/** `range` without its upper bounds, or `undefined` when nothing is left. */
export function floorOf(range: VersionRange): VersionRange | undefined {
  if (range.unreleased) return range;
  const comparators = range.comparators.filter((c) => c.operator === ">=" || c.operator === ">");
  if (comparators.length === 0) return undefined;
  return { raw: comparators.map((c) => `${c.operator}${c.raw}`).join(" "), comparators };
}

function blockConstraints(block: RequiresBlock, source: RequirementSource, ownCeiling: boolean): RangeConstraint[] {
  const out: RangeConstraint[] = [];
  for (const key of REQUIREMENT_KEYS) {
    let range = rangeOf(block, key);
    if (range && key === "telo" && !ownCeiling) range = floorOf(range);
    if (range) out.push({ key, range, source });
  }
  return out;
}

function entryConstraints(entry: Restriction, version: string | undefined): RangeConstraint[] {
  const source = restrictionSource(entry, version);
  return REQUIREMENT_KEYS.flatMap((key) => {
    const range = rangeOf(entry.requires, key);
    return range ? [{ key, range, source }] : [];
  });
}

function restrictionSource(entry: Restriction, version: string | undefined): RequirementSource {
  return { from: "restriction", version, index: entry.index, reason: entry.reason };
}

function newest<T extends { module: ModuleRequirements }>(list: T[]): T | undefined {
  return list.reduce<T | undefined>(
    (best, s) => (best === undefined || (compareModuleVersions(s.module.version!, best.module.version!) ?? 0) > 0 ? s : best),
    undefined,
  );
}

function holds(cmp: VersionComparator, core: string): boolean {
  return rangeAccepts({ raw: cmp.raw, comparators: [cmp] }, core);
}

function failed(
  direction: "newer" | "older",
  key: RequirementKey,
  comparator: VersionComparator,
  running: string,
  source: RequirementSource,
): RangeVerdict {
  return {
    satisfied: false,
    direction,
    key,
    bound: `${comparator.operator}${comparator.raw}`,
    comparator,
    running,
    source,
  };
}
