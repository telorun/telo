import type { LoadedGraph } from "@telorun/analyzer";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import * as fs from "fs/promises";
import { createRequire } from "module";
import * as path from "path";
import { fileURLToPath } from "url";

/**
 * Hash-keyed analysis cache: a tiny JSON sidecar in `.telo/manifests/`
 * recording that an exact set of manifest bytes — under specific
 * `@telorun/kernel` and `@telorun/analyzer` package versions — passed
 * `analyzer.analyzeErrors`. The next `kernel.load` reads the sidecar
 * and, if signatures match, skips the per-resource validation walk.
 *
 * Lives next to the manifest cache (`LocalManifestCacheSource`) but is
 * independent of it — splitting both for grep-ability and because the
 * concerns (URL → file content vs. content → analyzer verdict) are
 * orthogonal.
 */

const CACHE_SUBDIR = ".telo/manifests";

/** File-format version of the analysis stamp envelope. Only bumped when
 *  the on-disk *layout* changes (new fields, restructured payload). The
 *  *semantic* invalidation — "did the analyzer's logic change?" — is
 *  handled by baking the resolved `@telorun/analyzer` / `@telorun/kernel`
 *  package versions into the signature itself, so any pnpm/npm install
 *  that bumps either package automatically invalidates every stamp on
 *  disk. A hand-maintained integer for that purpose would silently mask
 *  newly-stricter validation until the next manifest edit. */
const ANALYSIS_STAMP_FORMAT_VERSION = 1;
const ANALYSIS_STAMP_FILE = `${CACHE_SUBDIR}/.validated.json`;

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

/** Read the stamped analysis verdict for the entry at `entryDir`, or
 *  `undefined` when missing / unreadable / format-mismatched. The
 *  `version` field is the on-disk *format* version; semantic
 *  invalidation flows through the signature (which embeds package
 *  versions). A future format change bumps `version` so older kernels
 *  reading a newer stamp (or vice versa) discard rather than misparse. */
export async function readAnalysisStamp(
  entryDir: string,
): Promise<AnalysisStamp | undefined> {
  try {
    const text = await fs.readFile(path.join(entryDir, ANALYSIS_STAMP_FILE), "utf-8");
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
  entryDir: string,
  signature: string,
): Promise<void> {
  const stamp: AnalysisStamp = {
    version: ANALYSIS_STAMP_FORMAT_VERSION,
    signature,
  };
  const target = path.join(entryDir, ANALYSIS_STAMP_FILE);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(stamp), "utf-8");
}
