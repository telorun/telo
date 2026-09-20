import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

/**
 * The CLI's own version, and the debug UI version it fetches — the two answers
 * this package would otherwise read out of a `package.json` at runtime.
 *
 * A standalone binary has no `package.json`: it is one file. Asked there, the
 * question used to produce `unknown`, which `telo --version` printed and the
 * debug UI fetch quietly gave up on. The build bakes both values instead
 * (`__TELO_BAKED_VERSIONS__`), and the disk read stays the path for every other
 * distribution.
 *
 * `undefined` rather than a placeholder when neither answers, so each caller
 * decides what that means — `--version` falls back to what yargs can find, and
 * the debug UI fetch reports that it cannot pick a version instead of fetching
 * one called "unknown".
 */

declare const __TELO_BAKED_VERSIONS__: Record<string, string> | undefined;

const baked: Record<string, string> =
  typeof __TELO_BAKED_VERSIONS__ === "object" && __TELO_BAKED_VERSIONS__ !== null
    ? __TELO_BAKED_VERSIONS__
    : {};

/** Walk up from this module to the CLI's own `package.json`, which works from
 *  both the compiled `dist/**` layout and the Bun-run `src/**` one. */
function ownPackageJson(): Record<string, unknown> | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        return JSON.parse(fs.readFileSync(candidate, "utf8")) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A version the build baked in, or `undefined` when this is not a baked
 *  build. The binary keys its unpacked esbuild on one; nothing else may
 *  invent a placeholder for it. */
export function bakedVersion(name: string): string | undefined {
  return baked[name];
}

export function cliVersion(): string | undefined {
  if (baked["@telorun/cli"]) return baked["@telorun/cli"];
  const version = ownPackageJson()?.version;
  return typeof version === "string" ? version : undefined;
}

/**
 * Whether this CLI IS a released artifact, as opposed to a working copy.
 *
 * A version number is not an identity for an unreleased tree: a checkout and the
 * release of the same version number can be arbitrarily different code. That
 * distinction is invisible almost everywhere and load-bearing in exactly one
 * place — `telo package`, which otherwise puts a DOWNLOADED binary of the same
 * version number around an application and calls it "the telo that built it".
 *
 * Two signals, one per distribution shape, and neither is a guess: a binary says
 * which build it is (`build`, baked by the release workflow), and an npm
 * package's own manifest still naming `workspace:` dependencies is a checkout,
 * since publishing rewrites those to concrete versions.
 */
export function distributionKind(
  pkg: Record<string, unknown> | null = ownPackageJson(),
  build: string | undefined = baked["build"],
): "release" | "checkout" | "unknown" {
  if (build) return build === "release" ? "release" : "checkout";
  // A single-file executable has no `package.json` to walk up to, so an unbaked
  // one cannot say what it is — and a claim nothing can check is exactly what
  // this exists to refuse.
  if (!pkg) return "unknown";
  const specifiers = [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]
    .flatMap((group) => Object.values((group ?? {}) as Record<string, unknown>))
    .filter((value): value is string => typeof value === "string");
  return specifiers.some((value) => value.startsWith("workspace:")) ? "checkout" : "release";
}

/** The `@telorun/debug-ui` version the inspect UI is fetched at.
 *
 *  `TELO_DEBUG_UI_VERSION` wins over both: container images set it because
 *  `pnpm deploy` — unlike `pnpm publish` — leaves the dependency pinned at
 *  `workspace:*`, which names no concrete version to fetch. */
export function debugUiVersion(): string | undefined {
  const fromEnv = process.env.TELO_DEBUG_UI_VERSION?.trim();
  if (fromEnv) return fromEnv;
  if (baked["@telorun/debug-ui"]) return baked["@telorun/debug-ui"];
  const pkg = ownPackageJson();
  for (const field of ["devDependencies", "dependencies"] as const) {
    const pinned = (pkg?.[field] as Record<string, string> | undefined)?.["@telorun/debug-ui"];
    // A `workspace:*` pin names no version; only a concrete one is fetchable.
    if (pinned && /^\d+\.\d+\.\d+/.test(pinned)) return pinned;
  }
  return undefined;
}
