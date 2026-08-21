import type { LoadedGraph } from "@telorun/analyzer";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import * as fs from "fs/promises";
import { createRequire } from "module";
import * as path from "path";
import { fileURLToPath } from "url";

/**
 * Hash-keyed analysis cache: a tiny JSON sidecar under `.telo/analysis/`
 * recording that an exact set of manifest bytes — under specific
 * `@telorun/kernel` and `@telorun/analyzer` package versions — passed
 * `analyzer.analyzeErrors`. The next `kernel.load` reads the sidecar
 * and, if signatures match, skips the per-resource validation walk.
 *
 * ONE STAMP PER ENTRY, in a directory keyed by a hash of the entry URL.
 * A single file holding a single signature was per-app only because every app
 * used to get its own `.telo` beside its manifest; once the cache root is shared
 * across a workspace, one file means each app overwrites the last — A stamps, B
 * misses and overwrites, forever. That is a permanent 100% miss with no error to
 * show for it, worst in the test suite, where a kernel is spawned per manifest
 * and the cache matters most.
 *
 * A DIRECTORY rather than several records in one file, because two kernels
 * loading different manifests concurrently would otherwise read-modify-write the
 * same JSON and lose each other's entry — and concurrent loads are the normal
 * case, not the exception.
 *
 * NOT under `manifests/`, which holds cached module manifests keyed by transport.
 * A verdict about an entry is not a manifest; filing it there made the directory
 * mean two things.
 */


/** File-format version of the analysis stamp envelope. Only bumped when
 *  the on-disk *layout* changes (new fields, restructured payload). The
 *  *semantic* invalidation — "did the analyzer's logic change?" — is
 *  handled by baking the resolved `@telorun/analyzer` / `@telorun/kernel`
 *  package versions into the signature itself, so any pnpm/npm install
 *  that bumps either package automatically invalidates every stamp on
 *  disk. A hand-maintained integer for that purpose would silently mask
 *  newly-stricter validation until the next manifest edit. */
const ANALYSIS_STAMP_FORMAT_VERSION = 1;

const localRequire = createRequire(import.meta.url);

/** Read the kernel's own `package.json` — `createRequire` can't resolve
 *  `@telorun/kernel/package.json` from inside the kernel package itself
 *  (the self-reference loops in some node_modules layouts). The file
 *  sits two levels up from `dist/manifest-sources/`. */
function readKernelVersion(): string {
  try {
    const url = new URL("../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(url), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function readDepVersion(spec: string): string {
  // Fast path: direct `require("<pkg>/package.json")`. Fails (with
  // ERR_PACKAGE_PATH_NOT_EXPORTED) when the dependency declares a strict
  // `exports` map without listing `./package.json` — common for packages
  // that consider package.json an implementation detail. Don't return
  // "unknown" in that case; fall back to resolving the package's main
  // entry and walking the filesystem up to its package.json.
  const pkgJsonSpec = spec.endsWith("/package.json")
    ? spec
    : `${spec}/package.json`;
  try {
    const pkg = localRequire(pkgJsonSpec);
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    // fall through to filesystem walk
  }
  try {
    const mainSpec = spec.endsWith("/package.json") ? spec.slice(0, -13) : spec;
    const entry = localRequire.resolve(mainSpec);
    let dir = path.dirname(entry);
    while (dir !== path.dirname(dir)) {
      const candidate = path.join(dir, "package.json");
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
        // Guard against scoped-package interior package.json files (some
        // packages stamp one in dist/) — match by name when the spec
        // names a package.
        const expectedName = mainSpec
          .split("/")
          .slice(0, mainSpec.startsWith("@") ? 2 : 1)
          .join("/");
        if (typeof pkg.name === "string" && pkg.name === expectedName) {
          return typeof pkg.version === "string" ? pkg.version : "unknown";
        }
      } catch {
        // not at the package root yet — keep walking
      }
      dir = path.dirname(dir);
    }
  } catch {
    // resolution failed — package not installed at all
  }
  return "unknown";
}

const KERNEL_VERSION = readKernelVersion();
const ANALYZER_VERSION = readDepVersion("@telorun/analyzer");

export interface AnalysisStamp {
  version: number;
  signature: string;
}

/** Hash every owner + partial file in `graph` together with the resolved
 *  `@telorun/kernel` and `@telorun/analyzer` versions into one content
 *  signature. Two loads of the same manifest set under the same package
 *  versions produce the same signature; any edit to any reachable file —
 *  or any pnpm/npm install that bumps the kernel or analyzer — flips it.
 *  This is what the kernel uses to decide whether the previous analyzer
 *  run's verdict still applies. */
export function computeAnalysisSignature(graph: LoadedGraph): string {
  const entries: Array<[string, string]> = [];
  for (const [, mod] of graph.modules) {
    for (const file of [mod.owner, ...mod.partials]) {
      const digest = createHash("sha256").update(file.text).digest("hex");
      entries.push([file.source, digest]);
    }
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256")
    .update(
      JSON.stringify({
        kernel: KERNEL_VERSION,
        analyzer: ANALYZER_VERSION,
        files: entries,
      }),
    )
    .digest("hex");
}

/** Where one entry's stamp lives: `<analysisDir>/<hash of entry URL>.json`.
 *
 *  Keyed by the entry URL rather than by its directory, because two manifests in
 *  one directory (an app and its test harness) are two entries with two verdicts,
 *  and a shared cache root makes the directory a far weaker discriminator than it
 *  used to be. */
function stampPath(analysisDir: string, entryUrl: string): string {
  const id = createHash("sha256").update(entryUrl).digest("hex").slice(0, 32);
  return path.join(analysisDir, `${id}.json`);
}

/** Read the stamped analysis verdict for `entryUrl`, or `undefined` when
 *  missing / unreadable / format-mismatched. The `version` field is the
 *  on-disk *format* version; semantic invalidation flows through the
 *  signature (which embeds package versions). A future format change bumps
 *  `version` so older kernels reading a newer stamp (or vice versa) discard
 *  rather than misparse.
 *
 *  A pre-workspace-anchor `.telo/manifests/.validated.json` is simply never
 *  looked at: it is a file where this layout wants a directory, so neither
 *  version of the kernel can misread the other's. */
export async function readAnalysisStamp(
  entryUrl: string,
  analysisDir: string,
): Promise<AnalysisStamp | undefined> {
  try {
    const text = await fs.readFile(stampPath(analysisDir, entryUrl), "utf-8");
    const parsed = JSON.parse(text) as Partial<AnalysisStamp>;
    if (
      parsed?.version === ANALYSIS_STAMP_FORMAT_VERSION &&
      typeof parsed?.signature === "string"
    ) {
      return parsed as AnalysisStamp;
    }
  } catch {
    // missing / unreadable / unparseable — treat as cache miss
  }
  return undefined;
}

/** Persist the analysis verdict so the next `kernel.load` can skip the
 *  per-resource validation walk when the manifest set is unchanged.
 *  Idempotent; safe to call after every successful load. */
export async function writeAnalysisStamp(
  entryUrl: string,
  signature: string,
  analysisDir: string,
): Promise<void> {
  const stamp: AnalysisStamp = {
    version: ANALYSIS_STAMP_FORMAT_VERSION,
    signature,
  };
  const target = stampPath(analysisDir, entryUrl);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Temp file + rename, as the controller-source cache does. Two kernels loading
  // the SAME entry concurrently — the normal case for a shared root, where a test
  // suite runs many manifests at once — would otherwise interleave writes to one
  // path. A torn stamp is read as a miss rather than as a wrong verdict, so the
  // cost is a silent re-validation, but rename makes it unrepresentable for the
  // price of one syscall.
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(stamp), "utf-8");
  await fs.rename(tmp, target);
}
