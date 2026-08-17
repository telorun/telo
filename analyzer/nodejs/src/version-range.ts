/**
 * The version-range grammar `requires:` declares, and the only one Telo reads.
 *
 * Built on `module-version-order.ts`'s precedence rather than the `semver`
 * package, for that file's reason: the analyzer is browser-safe, so the editor
 * reaches the identical rule the kernel does. A second implementation of "does
 * this version satisfy this range" would eventually disagree about what a
 * manifest means, which is the whole failure this mechanism exists to prevent.
 *
 * **A range is a CONJUNCTION of explicit comparators** — `>=0.80.0`,
 * `>=0.40.0 <0.50.0`, `>=0.40.0,<0.50.0`. That is deliberately narrower than
 * npm's grammar, and every exclusion pays for itself:
 *
 *  - **`^` and `~` are rejected**, not reinterpreted. On a `0.x` version both
 *    mean a single minor (`^0.40.0` is `>=0.40.0 <0.41.0`, identical to
 *    `~0.40.0`), and Telo ships breaking changes as minor bumps deliberately. So
 *    the caret reading is *correct* and therefore useless — every module would
 *    pin to one breaking-change generation and nobody could move telo without
 *    the whole standard library republishing. It is also the spelling semver
 *    intuition reaches for first, so accepting it would make the failure both
 *    common and silent.
 *  - **A bare version is rejected.** npm reads `0.80.0` as an exact pin, which is
 *    the same trap in a different costume; reading it as `>=` would contradict
 *    every other semver consumer. Refusing it and naming the two spellings is
 *    the only answer that cannot be misread.
 *  - **`||`, hyphen ranges, `*` and `x` are rejected.** A disjunction has no
 *    single low or high edge, and the edges are load-bearing: verification runs
 *    the CLI *at* them, and a declared upper bound must be checked for existence.
 *    A grammar whose edges are undefined cannot be verified, and an unverifiable
 *    bound is what this design forbids everywhere else.
 *
 * **Prereleases compare by plain precedence**, with no equivalent of npm's rule
 * that a prerelease only satisfies a range mentioning one at the same
 * `[major, minor, patch]`. That rule exists to stop a caret range dragging a
 * consumer onto an `-rc` build; here the version being tested is *the runtime the
 * user is already running*, not a candidate being selected for them, so the
 * honest answer is the precedence one — a developer on `0.81.0-rc.1` satisfies
 * `>=0.80.0` because they genuinely are past it.
 */

import {
  compareParsedModuleVersions,
  parseModuleVersion,
  type ParsedModuleVersion,
} from "./module-version-order.js";

/** The comparison a single term applies. */
export type ComparatorOperator = ">=" | ">" | "<=" | "<";

export interface VersionComparator {
  operator: ComparatorOperator;
  /** The version as authored, for diagnostics and for the existence check. */
  raw: string;
  parsed: ParsedModuleVersion;
}

/** A parsed range: every comparator must hold. Never empty. */
export interface VersionRange {
  /** The range exactly as authored, quoted verbatim in diagnostics. */
  raw: string;
  comparators: VersionComparator[];
}

/** Why a range string was refused. `hint` is the spelling to use instead, when
 *  there is an unambiguous one — a rejection that cannot say what to write
 *  instead is a worse diagnostic than the value it rejects. */
export interface VersionRangeError {
  message: string;
  hint?: string;
}

export type VersionRangeResult =
  | { ok: true; range: VersionRange }
  | { ok: false; error: VersionRangeError };

/** Operators longest-first, so `>=` is matched before `>`. */
const OPERATORS: ComparatorOperator[] = [">=", "<=", ">", "<"];

function refuse(message: string, hint?: string): VersionRangeResult {
  return { ok: false, error: hint === undefined ? { message } : { message, hint } };
}

/**
 * Refuse with `>=<version>` as the hint — but only when that hint would itself
 * parse.
 *
 * A hint is a repair the author is meant to paste, so one this parser would
 * reject on the next run is worse than no hint at all: it converts a diagnostic
 * the author can act on into a loop. Everything unparseable (a two-segment
 * version, a date, a leftover placeholder) falls back to the message alone,
 * which still names what is wrong.
 */
function hintedRefusal(message: string, version: string): VersionRangeResult {
  return parseModuleVersion(version) ? refuse(message, `>=${version}`) : refuse(message);
}

/**
 * Parse a range, or explain why it cannot be one. Never throws and never
 * degrades to a permissive reading: a range this refuses is reported, not
 * silently treated as "no requirement".
 */
export function parseVersionRange(raw: unknown): VersionRangeResult {
  if (typeof raw !== "string" || raw.trim() === "") {
    return refuse(`expected a version range string, got ${describe(raw)}`);
  }
  const text = raw.trim();

  if (text.includes("||")) {
    return refuse(
      `'${text}' is a disjunction. A range must be a conjunction of comparators, because ` +
        `verification runs the CLI at its lowest and highest bound and a disjunction has neither`,
    );
  }
  if (/\s-\s/.test(text)) {
    return refuse(
      `'${text}' is a hyphen range`,
      `${text.split(/\s-\s/)[0]?.trim() ?? ""} rewritten as '>=' and '<=' comparators`,
    );
  }

  const terms = text.split(/[\s,]+/).filter((t) => t !== "");
  const comparators: VersionComparator[] = [];

  for (const term of terms) {
    if (term.startsWith("^") || term.startsWith("~")) {
      const version = term.slice(1);
      const parsed = parseModuleVersion(version);
      const upper =
        parsed && parsed.major === 0 ? `0.${parsed.minor + 1}.0` : `${(parsed?.major ?? 0) + 1}.0.0`;
      return refuse(
        `'${term}' is not accepted. Pre-1.0, '${term[0]}' allows only ${version} up to ` +
          `${upper}, and Telo ships breaking changes as minor bumps — so it pins this module to ` +
          `a single release generation, which is almost never what is meant`,
        `>=${version}`,
      );
    }
    // Any `x`/`*` placeholder, at any position — `*`, `x`, `1.x`, `1.2.x`,
    // `1.2.*`. Catching only some of them sent the rest to the no-comparator
    // branch below, which suggested `>=1.2.*` — a hint this very parser rejects,
    // which is worse than the value it was rejecting.
    if (/(^|\.)[x*]$/i.test(term) || /(^|\.)[x*]\./i.test(term)) {
      return refuse(`'${term}' is a wildcard range; write explicit comparators instead`);
    }
    if (term.startsWith("=")) {
      return hintedRefusal(`'${term}' pins one exact version`, term.replace(/^=+/, ""));
    }

    const operator = OPERATORS.find((op) => term.startsWith(op));
    if (!operator) {
      return hintedRefusal(
        `'${term}' has no comparator. A bare version reads as an exact pin in semver, which is ` +
          `almost never meant here`,
        term,
      );
    }
    const version = term.slice(operator.length).trim();
    const parsed = parseModuleVersion(version);
    if (!parsed) {
      return refuse(
        `'${version}' in '${term}' is not a three-part version (X.Y.Z, optionally -prerelease)`,
      );
    }
    comparators.push({ operator, raw: version, parsed });
  }

  if (comparators.length === 0) return refuse(`'${text}' declares no comparator`);
  return { ok: true, range: { raw: text, comparators } };
}

/** True when `version` satisfies every comparator. An unparseable `version` is
 *  `false` — never a pass, since the caller is asking whether a real runtime is
 *  admitted and "cannot tell" must not read as "yes". */
export function rangeAccepts(range: VersionRange, version: string): boolean {
  const parsed = parseModuleVersion(version);
  if (!parsed) return false;
  return range.comparators.every((c) => {
    const cmp = compareParsedModuleVersions(parsed, c.parsed);
    switch (c.operator) {
      case ">=":
        return cmp >= 0;
      case ">":
        return cmp > 0;
      case "<=":
        return cmp <= 0;
      case "<":
        return cmp < 0;
    }
  });
}

/** The lower-bound comparator, or `undefined` when the range is open below.
 *  This is the version verification installs and runs as the low edge. */
export function lowerBound(range: VersionRange): VersionComparator | undefined {
  return highest(range.comparators.filter((c) => c.operator === ">=" || c.operator === ">"));
}

/** The upper-bound comparator, or `undefined` when the range is open above —
 *  the normal case, where the high edge is HEAD and normal CI already covers it. */
export function upperBound(range: VersionRange): VersionComparator | undefined {
  return lowest(range.comparators.filter((c) => c.operator === "<=" || c.operator === "<"));
}

/** The tightest of several same-direction bounds wins; a range may legitimately
 *  state more than one, and only the binding bound is an edge worth testing. */
function highest(list: VersionComparator[]): VersionComparator | undefined {
  return list.reduce<VersionComparator | undefined>(
    (best, c) =>
      best === undefined || compareParsedModuleVersions(c.parsed, best.parsed) > 0 ? c : best,
    undefined,
  );
}

function lowest(list: VersionComparator[]): VersionComparator | undefined {
  return list.reduce<VersionComparator | undefined>(
    (best, c) =>
      best === undefined || compareParsedModuleVersions(c.parsed, best.parsed) < 0 ? c : best,
    undefined,
  );
}

/** True when no version can satisfy the range — `>=0.90.0 <0.80.0`. Reported
 *  rather than left to fail mysteriously at every consumer. */
export function isUnsatisfiable(range: VersionRange): boolean {
  const low = lowerBound(range);
  const high = upperBound(range);
  if (!low || !high) return false;
  const cmp = compareParsedModuleVersions(low.parsed, high.parsed);
  if (cmp > 0) return true;
  // `>=X <X` and `>X <=X` admit nothing; `>=X <=X` admits exactly X.
  if (cmp === 0) return low.operator === ">" || high.operator === "<";
  return false;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
