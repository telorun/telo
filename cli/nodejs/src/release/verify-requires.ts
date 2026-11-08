/**
 * The publish preflight for a module's declared `requires.telo` floor — by
 * RUNNING the published CLI at the floor over the measurement copy
 * (`floor-measurement.ts`).
 *
 * This is the only verification an author outside a release workspace gets; a
 * workspace measures its floors instead (`telo release floor` / `check`). Authors
 * outside one keep writing floors by hand, against released versions.
 *
 * **Why execution rather than a `since:` table.** A table annotating every
 * vocabulary entry with the version that introduced it re-creates the discipline
 * problem one level down — forgetting is silent — and cannot see a SHAPE change.
 * Running the old CLI is not a prediction of the property; it IS the property,
 * executed. A floor is the only edge to run: support only grows in newer
 * releases, so nothing above it can fail while it passes, and a range has no
 * ceiling to verify.
 *
 * **Infrastructure failure warns; evidence of breakage fails.** A CLI that cannot
 * be installed (offline, a registry outage) or that exits without reporting on
 * the manifest leaves the claim unverified; blocking a publish on network
 * reachability trades one failure for a worse one. A CLI that runs and rejects
 * the measured manifest is evidence.
 *
 * **A floor naming a release npm does not have is `pending`, and fatal at
 * publish** (informational nowhere now: `telo release check` measures instead).
 * Publication runs npm before modules, so by the time a module is pushed its
 * floor exists; if it does not, the release is out of order and every consumer's
 * `telo upgrade` would refuse the version it is about to receive.
 */

import { isNewerModuleVersion, newestModuleVersion, type Restriction } from "@telorun/analyzer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  FloorMeasurementError,
  FloorProbe,
  declaredFloor,
  describeReading,
  npxRunner,
  type CliRunner,
} from "./floor-measurement.js";

const run = promisify(execFile);

export type FloorOutcome =
  /** The module declares no floor. */
  | { status: "none" }
  /** The floor holds: the CLI at it accepted the measurement copy. */
  | { status: "passed"; floor: string; checkedWith: string }
  /** The CLI at the floor rejected it — the declared floor is false. */
  | { status: "failed"; floor: string; reading: string }
  /** The floor names a release newer than anything published. */
  | { status: "pending"; floor: string; latestPublished: string }
  /** The CLI could not be run, or said nothing about the manifest. */
  | { status: "unavailable"; floor: string; reason: string };

/**
 * Verify a module manifest's declared floor. `currentVersion` is the running
 * CLI: the caller has ALREADY checked this manifest with it (`publishOne` runs
 * static analysis first), and `telo` is not on PATH in a development checkout, so
 * spawning it would only ENOENT.
 */
export async function verifyFloor(
  manifestPath: string,
  text: string,
  options: {
    currentVersion: string;
    /** Published `@telorun/cli` versions; `null` when the registry could not be
     *  asked, in which case no floor is classified `pending`. */
    publishedVersions?: string[] | null;
    runner?: CliRunner;
  },
): Promise<FloorOutcome> {
  const { floor } = declaredFloor(text);
  if (floor.kind === "none") return { status: "none" };
  if (floor.kind === "unreleased") {
    const latest = newestModuleVersion(options.publishedVersions ?? []) ?? "unknown";
    return { status: "pending", floor: ">=unreleased", latestPublished: latest };
  }
  const declared = `>=${floor.version}`;
  if (floor.version === options.currentVersion) {
    return { status: "passed", floor: declared, checkedWith: floor.version };
  }
  const latestPublished = unreleasedEdge(floor.version, options.publishedVersions ?? null);
  if (latestPublished !== undefined) return { status: "pending", floor: declared, latestPublished };

  try {
    const verdict = (
      await new FloorProbe(options.runner ?? npxRunner).probe(floor.version, floor.version, [
        { key: manifestPath, manifestPath, text },
      ])
    ).get(manifestPath)!;
    return verdict.accepted
      ? { status: "passed", floor: declared, checkedWith: floor.version }
      : { status: "failed", floor: declared, reading: describeReading(verdict.reading) };
  } catch (err) {
    if (!(err instanceof FloorMeasurementError)) throw err;
    return { status: "unavailable", floor: declared, reason: err.message };
  }
}

/**
 * The latest published version when `floor` names something NEWER than it — a
 * forward-declared floor, whose verification waits for that release. `undefined`
 * when the floor exists, when it is older than the latest (a yanked version is
 * left to the run, whose failure is honest about it), or when the registry could
 * not be asked.
 */
export function unreleasedEdge(edge: string, published: string[] | null): string | undefined {
  if (published === null) return undefined;
  const normalized = published.map((v) => (v.startsWith("v") ? v.slice(1) : v));
  if (normalized.includes(edge)) return undefined;
  // Candidates are skipped: a floor is a final release, so an `-rc` build of
  // the release that will carry it must not make the floor look published.
  const latest = newestModuleVersion(normalized);
  if (latest === undefined) return undefined;
  return isNewerModuleVersion(edge, latest) ? latest : undefined;
}

/**
 * The first `telo` bound in a `restrictions:` entry naming a version that is not a
 * published final: a bound nothing can run is a bound nothing can verify.
 * `undefined` when every bound exists, or when the registry could not be asked.
 */
export function unpublishedRestrictionBound(
  entries: readonly Restriction[],
  published: string[] | null,
): { index: number; bound: string } | undefined {
  if (published === null) return undefined;
  const finals = new Set(
    published.map((v) => (v.startsWith("v") ? v.slice(1) : v)).filter((v) => !v.includes("-")),
  );
  for (const entry of entries) {
    for (const comparator of entry.requires.telo?.comparators ?? []) {
      if (!finals.has(comparator.raw)) return { index: entry.index, bound: comparator.raw };
    }
  }
  return undefined;
}

/**
 * The published `@telorun/cli` versions, for telling a forward-declared floor
 * from an unreachable registry. `null` when the registry could not be reached —
 * the caller warns rather than blocking.
 *
 * **Memoized for the process**, because `telo publish` runs per module and
 * `scripts/publish-modules.mjs` publishes the whole standard library in one
 * pass: one release would otherwise be ~60 `npm view` round trips for a single
 * answer that cannot change mid-run. The failed lookup is cached too — a registry
 * unreachable for the first module is unreachable for the rest.
 */
let publishedVersionsCache: Promise<string[] | null> | undefined;

export function resetPublishedTeloVersionsCache(): void {
  publishedVersionsCache = undefined;
}

export function publishedTeloVersions(): Promise<string[] | null> {
  publishedVersionsCache ??= fetchPublishedTeloVersions();
  return publishedVersionsCache;
}

async function fetchPublishedTeloVersions(): Promise<string[] | null> {
  try {
    const { stdout } = await run("npm", ["view", "@telorun/cli", "versions", "--json"], {
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed: unknown = JSON.parse(stdout);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
    return typeof parsed === "string" ? [parsed] : null;
  } catch {
    return null;
  }
}
