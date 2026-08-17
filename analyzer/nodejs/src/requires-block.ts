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
 * **Ordering is normative: `telo` is checked before `host`, and before any
 * unknown-axis complaint.** A module using an axis introduced in telo 0.85 also
 * declares telo `>=0.85`, so an older runtime fails on the telo axis first and
 * never has to decide what an axis it has never heard of means. That is what
 * makes the block safely extensible; consumers get the order from
 * {@link evaluateRequires} rather than re-deriving it.
 */

import { parseModuleVersion } from "./module-version-order.js";
import {
  isUnsatisfiable,
  parseVersionRange,
  rangeAccepts,
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
}

export interface ReadRequiresResult {
  /** Present whenever the doc carries a `requires:` key at all, even a malformed
   *  one — so a consumer can tell "declared nothing" from "declared badly". */
  declared: boolean;
  block: RequiresBlock;
  issues: RequiresIssue[];
}

const EMPTY: RequiresBlock = { host: {} };

/**
 * Read and parse the block off a module doc. Never throws. A malformed entry
 * yields an issue AND is omitted from the block, so a consumer enforcing the
 * block never silently treats garbage as a satisfied requirement — the issue is
 * what makes the manifest fail, exactly as a malformed zone annotation does.
 */
export function readRequires(doc: Record<string, unknown> | undefined): ReadRequiresResult {
  const raw = doc?.requires;
  if (raw === undefined) return { declared: false, block: EMPTY, issues: [] };

  const issues: RequiresIssue[] = [];
  const block: RequiresBlock = { host: {} };

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({
      path: "requires",
      message: `'requires' must be a mapping of axes, got ${describe(raw)}.`,
    });
    return { declared: true, block, issues };
  }

  const entries = raw as Record<string, unknown>;

  for (const key of Object.keys(entries)) {
    if (!(KNOWN_AXES as readonly string[]).includes(key)) {
      issues.push({
        path: `requires.${key}`,
        message:
          `'requires.${key}' is not a known axis. This runtime knows ` +
          `${KNOWN_AXES.map((a) => `'${a}'`).join(" and ")}; host requirements go under 'host'.`,
        unknownAxis: true,
      });
    }
  }

  if (entries.telo !== undefined) {
    const range = parseRangeAt(entries.telo, "requires.telo", issues);
    if (range) block.telo = range;
  }

  if (entries.host !== undefined) {
    const host = entries.host;
    if (host === null || typeof host !== "object" || Array.isArray(host)) {
      issues.push({
        path: "requires.host",
        message: `'requires.host' must be a mapping of host axes, got ${describe(host)}.`,
      });
    } else {
      for (const [axis, value] of Object.entries(host as Record<string, unknown>)) {
        if (!(KNOWN_HOST_AXES as readonly string[]).includes(axis)) {
          issues.push({
            path: `requires.host.${axis}`,
            message:
              `'requires.host.${axis}' is not a known host axis. This runtime knows ` +
              `${KNOWN_HOST_AXES.map((a) => `'${a}'`).join(", ")}.`,
            unknownAxis: true,
          });
          continue;
        }
        const range = parseRangeAt(value, `requires.host.${axis}`, issues);
        if (range) block.host[axis as HostAxis] = range;
      }
    }
  }

  return { declared: true, block, issues };
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

/** What a runtime concluded about a module's declared requirements. */
export type RequiresVerdict =
  | { satisfied: true }
  /** An axis whose declared range excludes the version this runtime reported. */
  | {
      satisfied: false;
      axis: "telo" | HostAxis;
      declared: VersionRange;
      running: string;
    };

/** The versions a host can speak for. Absent entries are not checked — the
 *  editor has no host to report, and an axis nothing supplies is skipped rather
 *  than guessed. Every axis in {@link KNOWN_HOST_AXES} has a supplier; an axis
 *  with none does not belong in the vocabulary (see the note there). */
export interface HostVersions {
  node?: string;
}

/**
 * Evaluate a module's declared requirements against the runtime performing the
 * analysis.
 *
 * `telo` is checked FIRST and short-circuits: a module using a host axis
 * introduced in a later telo also declares that telo, so an older runtime must
 * report the version skew rather than a host axis it may not even know. Absent
 * declarations are satisfied — the bootstrap rule, permanent for everything
 * published before the mechanism existed.
 *
 * **A version this cannot PARSE is satisfied, on every axis.** A runtime that
 * cannot name its own version must not start rejecting modules on the strength
 * of a number it could not read — the refusal-to-guess `module-version-order.ts`
 * makes, pointed in the safe direction. The test is a parse, not a shape: `0.76`
 * and `2024.1` look like versions and are not three-part ones, so a cheaper
 * check (a leading digit, say) would fail them CLOSED and gate every module in
 * the graph on a number nothing could compare. `AnalysisOptions.teloVersion` is
 * hand-written by definition, so that is exactly where such a value arrives.
 */
export function evaluateRequires(
  block: RequiresBlock,
  running: string | undefined,
  host: HostVersions = {},
): RequiresVerdict {
  const telo = check("telo", block.telo, running);
  if (telo) return telo;
  for (const axis of KNOWN_HOST_AXES) {
    const verdict = check(axis, block.host[axis], host[axis]);
    if (verdict) return verdict;
  }
  return { satisfied: true };
}

/** One axis, or `undefined` when it is satisfied / undeclared / unreportable. */
function check(
  axis: "telo" | HostAxis,
  declared: VersionRange | undefined,
  running: string | undefined,
): RequiresVerdict | undefined {
  if (!declared || !running) return undefined;
  if (!parseModuleVersion(running)) return undefined;
  if (rangeAccepts(declared, running)) return undefined;
  return { satisfied: false, axis, declared, running };
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
