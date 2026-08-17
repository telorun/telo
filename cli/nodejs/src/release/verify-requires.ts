/**
 * Verification of a module's declared `requires.telo` range — by RUNNING the CLI
 * at each edge of it.
 *
 * This is the half of declared runtime requirements that cannot live in the
 * analyzer: it spawns a process and reaches the network, while the analyzer is
 * browser-safe. It is also a *publishing* concern — an author editing a manifest
 * needs to know whether their runtime can read a module, not whether someone
 * else's declaration is honest.
 *
 * **Why execution rather than a `since:` table.** The obvious design annotates
 * every vocabulary entry with the version that introduced it and takes the
 * maximum over what a manifest uses. That re-creates the discipline problem one
 * level down — every future additive change must remember its `since`, and
 * forgetting is silent, which is the failure mode this whole mechanism exists to
 * remove — and it cannot see a *shape* change (an object where a zone annotation
 * used to take a pointer, a new key on a closed kernel-owned schema) without a
 * second annotation mechanism. Running the old CLI is not a prediction of the
 * property; it IS the property, executed.
 *
 * **Two edges bound the whole range**, rather than sampling it, because syntax
 * support is monotonic: a construct added in 0.43 works in 0.44 and later, one
 * removed in 0.60 works in 0.59 and earlier. Nothing in the middle can fail
 * while both edges pass. For a range open above the high edge is HEAD, which
 * normal CI already checks, so an open declaration costs one run.
 *
 * **Infrastructure failure warns; evidence of breakage fails.** A CLI that
 * cannot be installed (offline, a registry outage) leaves the claim unverified,
 * and blocking a publish on network reachability trades one failure for a worse
 * one. A CLI that runs and rejects the manifest is evidence, and evidence is
 * what this gate is for.
 */

import { readRequires, lowerBound, upperBound, type VersionRange } from "@telorun/analyzer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** How long a single edge check may take. An old CLI has to be fetched on first
 *  use, so this is generous; it exists to bound a hang, not to pace the work. */
const EDGE_TIMEOUT_MS = 300_000;

export type EdgeOutcome =
  /** The edge CLI ran and accepted the manifest. */
  | { edge: string; status: "passed" }
  /** The edge CLI ran and rejected it — the declared range is false. */
  | { edge: string; status: "failed"; output: string }
  /** The edge CLI could not be run. The claim is unverified, not disproven. */
  | { edge: string; status: "unavailable"; reason: string };

export interface VerifyRequiresResult {
  /** Absent when the module declares no `requires.telo` — nothing to verify. */
  declared?: VersionRange;
  outcomes: EdgeOutcome[];
  /** True when at least one edge produced evidence the declaration is false. */
  refuted: boolean;
}

/**
 * Verify a module manifest against the edges of its own declared range.
 *
 * `manifestPath` is checked, not the module directory, so the caller controls
 * which document is the subject. A module declaring nothing returns immediately:
 * absent means no requirement, permanently, for everything published before this
 * mechanism existed.
 */
export async function verifyRequires(
  manifestPath: string,
  moduleDoc: Record<string, unknown>,
  options: { currentVersion: string } ,
): Promise<VerifyRequiresResult> {
  const { block } = readRequires(moduleDoc);
  const declared = block.telo;
  if (!declared) return { outcomes: [], refuted: false };

  const edges: string[] = [];
  const low = lowerBound(declared);
  if (low) edges.push(low.raw);
  const high = upperBound(declared);
  // The high edge of an open range is HEAD, which the ordinary check already
  // covers; only a closed bound names a version worth installing. A bound equal
  // to the low edge is one edge, not two.
  if (high && high.raw !== low?.raw) edges.push(high.raw);

  const outcomes: EdgeOutcome[] = [];
  for (const edge of edges) {
    // The running CLI is the edge, and the caller has ALREADY checked this
    // manifest with it — `publishOne` runs static analysis before reaching here
    // and returns on any error. Spawning `telo check` would re-run that same
    // analysis to learn what we know; worse, `telo` is not on PATH in a
    // development checkout (it is `pnpm run telo`), so the spawn would ENOENT and
    // report a spurious "could not run" against every module.
    if (edge === options.currentVersion) {
      outcomes.push({ edge, status: "passed" });
      continue;
    }
    outcomes.push(await runEdge(manifestPath, edge));
  }

  return { declared, outcomes, refuted: outcomes.some((o) => o.status === "failed") };
}

async function runEdge(manifestPath: string, edge: string): Promise<EdgeOutcome> {
  try {
    await run("npx", ["-y", `@telorun/cli@${edge}`, "check", manifestPath], {
      timeout: EDGE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { edge, status: "passed" };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    if (typeof e.code !== "number") {
      // Never ran: the binary is missing, a fetch failed, the timeout fired. The
      // claim is unverified, not disproven, and the two must not be conflated.
      return { edge, status: "unavailable", reason: e.message ?? String(err) };
    }
    const output = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    if (!mentionsManifest(output, manifestPath)) {
      // It ran and exited non-zero WITHOUT saying anything about the manifest
      // under test. `telo check` also exits non-zero for an argument shape an
      // older parser does not accept, an unreachable remote import, or a bad
      // registry URL — and reporting any of those as "the declared range is
      // false" is precisely the misattribution this mechanism exists to remove.
      // Refuting a range needs evidence about THIS manifest.
      return {
        edge,
        status: "unavailable",
        reason:
          `telo ${edge} exited non-zero without reporting on ${manifestPath} — ` +
          `treating the range as unverified rather than refuted. Output: ` +
          `${output.slice(0, 400) || "(none)"}`,
      };
    }
    return { edge, status: "failed", output: output || (e.message ?? "check failed") };
  }
}

/** Whether the edge CLI's output actually concerns the manifest under test.
 *  Compared on the basename as well as the full path, since a CLI renders a
 *  path relative to its own cwd. */
function mentionsManifest(output: string, manifestPath: string): boolean {
  if (!output) return false;
  const base = manifestPath.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
  return output.includes(manifestPath) || (base.length > 0 && output.includes(base));
}

/**
 * The published `@telorun/cli` versions, for the "an upper bound must already
 * exist" check. `null` when the registry could not be reached — the caller warns
 * rather than blocking, since the rule gates a bound absent from almost every
 * module and an unreachable npm should not stop a publish.
 *
 * **Memoized for the process**, because `telo publish` runs per module and
 * `scripts/publish-packages.mjs` publishes the whole standard library in one
 * pass: without this, one release is ~60 `npm view` round trips (each with a
 * 60-second timeout) for a single answer that cannot change mid-run. The failed
 * lookup is cached too — a registry unreachable for the first module is
 * unreachable for the rest, and retrying it sixty times turns a warning into a
 * minutes-long stall.
 *
 * `@telorun/cli` is deliberately the package queried: it is the one the
 * verification path installs (`npx @telorun/cli@<edge>`) and the one
 * `TELO_SURFACE_VERSION` is generated from, so the constant, the existence check
 * and the thing that actually runs all name one package.
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

/** The declared upper bound when it names a version the registry does not have —
 *  an unverifiable bound, which the grammar exists to forbid. `undefined` when
 *  the range is open above, the bound exists, or the registry was unreachable. */
export function unpublishedUpperBound(
  declared: VersionRange | undefined,
  published: string[] | null,
): string | undefined {
  if (!declared || published === null) return undefined;
  const high = upperBound(declared);
  if (!high) return undefined;
  const normalized = new Set(published.map((v) => (v.startsWith("v") ? v.slice(1) : v)));
  return normalized.has(high.raw) ? undefined : high.raw;
}
