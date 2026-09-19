import { readFileSync } from "fs";
import { createRequire } from "module";
import * as path from "path";
import { fileURLToPath } from "url";

/**
 * The versions the kernel's on-disk caches are keyed by, and the one rule that
 * keeps those keys honest.
 *
 * Two caches embed a version in their key so that upgrading the code that built
 * an entry invalidates it: the analysis stamp embeds the kernel's and the
 * analyzer's, and a compiled validator embeds ajv's and ajv-formats'. Both used
 * to read the version out of a `package.json` at runtime and fall back to the
 * string `unknown` when they could not — which turned an unanswerable question
 * into a cache key that every version agrees on, so entries built by one version
 * were served to another. That is the failure a single-file executable makes
 * permanent (there is no `package.json` on disk to read at all), but nothing
 * about it is specific to one distribution.
 *
 * So: **a version that cannot be determined is never used as a key.**
 * `readVersion` returns `undefined` rather than a placeholder, and a cache whose
 * key is undefined neither reads nor writes — it misses, loudly, once.
 *
 * In a build that can know the answer ahead of time, it is baked in:
 * `__TELO_BAKED_VERSIONS__` is replaced at build time with a literal, so the
 * question is never asked at runtime. Everywhere else — an npm install, a
 * checkout run through Bun with no build step — the disk read stays the normal
 * path.
 */

declare const __TELO_BAKED_VERSIONS__: Record<string, string> | undefined;

const baked: Record<string, string> =
  typeof __TELO_BAKED_VERSIONS__ === "object" && __TELO_BAKED_VERSIONS__ !== null
    ? __TELO_BAKED_VERSIONS__
    : {};

const localRequire = createRequire(import.meta.url);

/** Read a dependency's version, or `undefined` when it cannot be determined.
 *
 *  The fast path is `require("<pkg>/package.json")`, which fails with
 *  `ERR_PACKAGE_PATH_NOT_EXPORTED` for a package whose `exports` map does not
 *  list it — common enough that a filesystem walk up from the package's main
 *  entry is the fallback rather than an admission of defeat. */
export function readVersion(spec: string): string | undefined {
  if (baked[spec]) return baked[spec];
  try {
    const pkg = localRequire(`${spec}/package.json`) as { version?: unknown };
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    // Restricted exports — fall through to the filesystem walk.
  }
  try {
    const entry = localRequire.resolve(spec);
    const expected = spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
    let dir = path.dirname(entry);
    while (dir !== path.dirname(dir)) {
      try {
        const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8")) as {
          name?: unknown;
          version?: unknown;
        };
        // Guard against the interior package.json some packages stamp into
        // `dist/`: only the one naming the package itself carries its version.
        if (pkg.name === expected) {
          return typeof pkg.version === "string" ? pkg.version : undefined;
        }
      } catch {
        // Not at the package root yet — keep walking.
      }
      dir = path.dirname(dir);
    }
  } catch {
    // Not installed.
  }
  return undefined;
}

/** The kernel's own version. `createRequire` cannot resolve
 *  `@telorun/kernel/package.json` from inside the kernel package itself (the
 *  self-reference loops in some node_modules layouts), so it is read by
 *  position: two levels up from `dist/`. */
export function readKernelVersion(): string | undefined {
  if (baked["@telorun/kernel"]) return baked["@telorun/kernel"];
  try {
    const url = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(url), "utf-8")) as { version?: unknown };
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    // Not on disk — a bundled kernel bakes the value instead.
  }
  return undefined;
}

/**
 * Report, once per process per cache, that a version could not be determined
 * and the cache is therefore disabled.
 *
 * Once rather than per entry: the condition is a property of the installation,
 * not of the entry being compiled, and one line per validator was how the same
 * class of failure went unnoticed before.
 */
const reported = new Set<string>();
export function reportUndeterminableVersion(
  cache: string,
  packages: ReadonlyArray<string>,
  report: (message: string) => void,
): void {
  if (reported.has(cache)) return;
  reported.add(cache);
  report(
    `telo: the ${cache} cache is disabled because the installed version of ${packages.join(
      " / ",
    )} could not be determined. Entries are neither read nor written, because a cache key that says "unknown" is shared by every version and would serve one version's entry to another.`,
  );
}
