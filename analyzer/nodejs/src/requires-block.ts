/**
 * The single reader of a module doc's `requires:` block — the version ranges of
 * runtime a module declares itself verified against. The load gate, the CLI's
 * publish preflight and `upgrade`'s candidate filter all recognise the block
 * here and nowhere else, the one-accessor rule `ref-slot.ts` and `zone-slot.ts`
 * established. Browser-safe: no Node built-ins, so the editor reaches the
 * identical rule the kernel does.
 *
 * ```yaml
 * requires:
 *   telo: ">=0.80.0"
 *   host:
 *     node: ">=20.0.0"
 * ```
 *
 * **Two tiers, and the split is not cosmetic.** `telo` names the *manifest
 * surface generation* a runtime implements — one scale shared by every kernel,
 * Node, Rust or Go, independent of each kernel's own release identity — and it
 * is the one axis verified by EXECUTION, by running the CLI at each edge of the
 * declared range. Host axes cannot be edge-verified by any CI; they are asserted
 * by the author and compared against the version the running host reports
 * ({@link HostVersions}). A flat map would imply one semantics for both.
 *
 * Nesting is also what disambiguates the names: `nodejs` and `rust` are already
 * *kernel labels* in this repo (`LABEL_TO_PURL_TYPE`, an `imports:` entry's
 * `runtime:`), so a top-level `node:` reads as the Node kernel rather than the
 * Node.js runtime — and no word escapes that, because the host runtime and the
 * kernel implementation genuinely share a name. Under `host:` position carries
 * the disambiguation and no word has to.
 *
 * **`requires.telo` is a floor only**: `>=<version>`, or `>=unreleased` — the
 * telo release that will carry it, which `telo release apply` writes in, met
 * only by a build whose version carries `+unreleased`. A ceiling is a `restrictions:` entry
 * (`restrictions.ts`); one on a module's own `requires.telo` is flagged
 * `ceiling` and kept in the block, since a published manifest's is honoured as a
 * restriction of that version. `host.node` keeps both bounds.
 *
 * **Ordering is normative: `telo` is checked before `host`, and before any
 * unknown-axis complaint.** A module using an axis introduced in telo 0.85 also
 * declares telo `>=0.85`, so an older runtime fails on the telo axis first and
 * never has to decide what an axis it has never heard of means. That is what
 * makes the block safely extensible; consumers get the order from
 * `evaluateRange` (`runtime-range.ts`) rather than re-deriving it.
 */

import {
  isUnsatisfiable,
  parseVersionRange,
  upperBound,
  type VersionRange,
} from "./version-range.js";

/**
 * Host axes this analyzer knows.
 *
 * **An axis is in this list only when something checks it.** A declared
 * requirement nothing compares is worse than no requirement at all: it validates,
 * it reads as protection, and it silently protects nobody — the exact failure
 * class this whole mechanism exists to remove, reintroduced inside it. So `rustc`
 * is deliberately absent until the slice that builds controller crates can
 * compare it; adding it there is a one-line change here plus a supplier in
 * {@link HostVersions}, and until then an author writing it is told it is not a
 * known axis rather than quietly reassured.
 *
 * Extending the set is a telo release, which is exactly why a module using a new
 * axis must also raise its `telo` bound — and why `telo` is checked first.
 */
export const KNOWN_HOST_AXES = ["node"] as const;
export type HostAxis = (typeof KNOWN_HOST_AXES)[number];

/** Top-level keys of the block. `host` is a container, `telo` a range. */
const KNOWN_AXES = ["telo", "host"] as const;

export interface RequiresBlock {
  /** The surface generation range, when declared. */
  telo?: VersionRange;
  /** Declared host axes, keyed by axis name. Empty when `host:` is absent. */
  host: Partial<Record<HostAxis, VersionRange>>;
}

export interface RequiresIssue {
  /** Dotted path within the doc, e.g. `requires.telo` or `requires.host.node`. */
  path: string;
  message: string;
  /** The spelling to use instead, when there is an unambiguous one. */
  hint?: string;
  /** True for an unrecognized axis, which consumers suppress while the `telo`
   *  requirement itself is unmet — an older runtime not knowing a newer axis is
   *  a consequence of the version skew, not a second defect to report. */
  unknownAxis?: boolean;
  /** True for an upper bound on a module's own `requires.telo`. The range stays
   *  in the block: a published manifest's ceiling is honoured as a restriction
   *  covering that version, while in a module's own source it is refused. */
  ceiling?: boolean;
}

export interface ReadRequiresResult {
  /** Present whenever the doc carries a `requires:` key at all, even a malformed
   *  one — so a consumer can tell "declared nothing" from "declared badly". */
  declared: boolean;
  block: RequiresBlock;
  issues: RequiresIssue[];
}

const EMPTY: RequiresBlock = { host: {} };

/** Where a requirement map is written: the module doc's own `requires:`, whose
 *  `telo` is a floor only, or a `restrictions:` entry's, which may also bound it
 *  from above. */
export type RequirementPlace = "module" | "restriction";

/** The `>=unreleased` floor: the telo release that will carry it, which
 *  `telo release apply` writes in, met only by a build of it. */
export const UNRELEASED_FLOOR = ">=unreleased";

/**
 * Read and parse the block off a module doc. Never throws. A malformed entry
 * yields an issue AND is omitted from the block, so a consumer enforcing the
 * block never silently treats garbage as a satisfied requirement — the issue is
 * what makes the manifest fail, exactly as a malformed zone annotation does.
 */
export function readRequires(doc: Record<string, unknown> | undefined): ReadRequiresResult {
  const raw = doc?.requires;
  if (raw === undefined) return { declared: false, block: EMPTY, issues: [] };
  const { block, issues } = readRequirementMap(raw, "requires", "module");
  return { declared: true, block, issues };
}

/** One requirement map — the module's `requires:` or an entry's — at `path`. */
export function readRequirementMap(
  raw: unknown,
  path: string,
  place: RequirementPlace,
): { block: RequiresBlock; issues: RequiresIssue[] } {
  const issues: RequiresIssue[] = [];
  const block: RequiresBlock = { host: {} };

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({
      path,
      message: `'${path}' must be a mapping of axes, got ${describe(raw)}.`,
    });
    return { block, issues };
  }

  const entries = raw as Record<string, unknown>;

  for (const key of Object.keys(entries)) {
    if (!(KNOWN_AXES as readonly string[]).includes(key)) {
      issues.push({
        path: `${path}.${key}`,
        message:
          `'${path}.${key}' is not a known axis. This runtime knows ` +
          `${KNOWN_AXES.map((a) => `'${a}'`).join(" and ")}; host requirements go under 'host'.`,
        unknownAxis: true,
      });
    }
  }

  if (entries.telo !== undefined) {
    const range = parseTeloAt(entries.telo, `${path}.telo`, place, issues);
    if (range) block.telo = range;
  }

  if (entries.host !== undefined) {
    const host = entries.host;
    if (host === null || typeof host !== "object" || Array.isArray(host)) {
      issues.push({
        path: `${path}.host`,
        message: `'${path}.host' must be a mapping of host axes, got ${describe(host)}.`,
      });
    } else {
      for (const [axis, value] of Object.entries(host as Record<string, unknown>)) {
        const at = `${path}.host.${axis}`;
        if (!(KNOWN_HOST_AXES as readonly string[]).includes(axis)) {
          issues.push({
            path: at,
            message:
              `'${at}' is not a known host axis. This runtime knows ` +
              `${KNOWN_HOST_AXES.map((a) => `'${a}'`).join(", ")}.`,
            unknownAxis: true,
          });
          continue;
        }
        if (namesUnreleased(value)) {
          issues.push({
            path: at,
            message:
              `${at} '${value.trim()}': unreleased names a telo release and is allowed only as ` +
              `a telo floor.`,
          });
          continue;
        }
        const range = parseRangeAt(value, at, issues);
        if (range) block.host[axis as HostAxis] = range;
      }
    }
  }

  return { block, issues };
}

function namesUnreleased(value: unknown): value is string {
  return typeof value === "string" && /\bunreleased\b/.test(value);
}

function parseTeloAt(
  value: unknown,
  path: string,
  place: RequirementPlace,
  issues: RequiresIssue[],
): VersionRange | undefined {
  if (namesUnreleased(value)) {
    const text = value.trim();
    if (text === UNRELEASED_FLOOR) return { raw: text, comparators: [], unreleased: true };
    issues.push({
      path,
      message: `${path} '${text}': unreleased is allowed only as the whole range '${UNRELEASED_FLOOR}'.`,
    });
    return undefined;
  }
  const range = parseRangeAt(value, path, issues);
  if (range && place === "module" && upperBound(range)) {
    issues.push({
      path,
      ceiling: true,
      message:
        `${path} '${range.raw}' declares an upper bound; requires.telo is a floor only. Write ` +
        `the ceiling as a restrictions: entry without versions, which covers this version.`,
    });
  }
  return range;
}

function parseRangeAt(
  value: unknown,
  path: string,
  issues: RequiresIssue[],
): VersionRange | undefined {
  const result = parseVersionRange(value);
  if (!result.ok) {
    issues.push({ path, message: `'${path}': ${result.error.message}.`, hint: result.error.hint });
    return undefined;
  }
  if (isUnsatisfiable(result.range)) {
    issues.push({
      path,
      message: `'${path}': '${result.range.raw}' admits no version — its bounds exclude each other.`,
    });
    return undefined;
  }
  return result.range;
}

/** The versions a host can speak for. Absent entries are not checked — the
 *  editor has no host to report, and an axis nothing supplies is skipped rather
 *  than guessed. Every axis in {@link KNOWN_HOST_AXES} has a supplier; an axis
 *  with none does not belong in the vocabulary (see the note there). */
export interface HostVersions {
  node?: string;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
