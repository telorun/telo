import * as fs from "fs";
import * as fsp from "fs/promises";
import { createRequire } from "module";
import * as path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);

/** jsDelivr base for the on-demand single-file debug UI. Overridable via env so
 *  an air-gapped mirror / staging bundle can be pointed at without a rebuild. */
const DEFAULT_CDN_BASE = "https://cdn.jsdelivr.net/npm";
const UI_PACKAGE = "@telorun/debug-ui";
const UI_ASSET = "app-single/index.html";

/** Walk up from this module to the CLI's own `package.json`. Works from both the
 *  compiled `dist/**` layout and the bun-run `src/**` layout. */
function readOwnPackageJson(): Record<string, any> | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        return JSON.parse(fs.readFileSync(candidate, "utf8"));
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The `@telorun/debug-ui` version to fetch. `TELO_DEBUG_UI_VERSION` wins (set by
 *  container images, where `pnpm deploy` — unlike `pnpm publish` — leaves the pin
 *  as `workspace:*`); otherwise read the CLI's own manifest, where the npm-publish
 *  flow has rewritten the devDep to an exact version. Returns null when neither
 *  yields a concrete version. */
function pinnedUiVersion(): string | null {
  const fromEnv = process.env.TELO_DEBUG_UI_VERSION?.trim();
  if (fromEnv) return fromEnv;
  const pkg = readOwnPackageJson();
  const raw = pkg?.devDependencies?.[UI_PACKAGE] ?? pkg?.dependencies?.[UI_PACKAGE];
  if (typeof raw !== "string") return null;
  const version = raw.replace(/^[\^~>=<\s]+/, "").trim();
  return /^\d/.test(version) ? version : null;
}

/** Outcome of resolving the debug UI bundle. `ok` resolved to a file on disk;
 *  `inline` was fetched into memory under `--no-cache-write` and is served
 *  without ever touching the (read-only) cache; `unavailable` carries a human
 *  `reason` — surfaced verbatim (e.g. the exact fetch URL that failed) rather than
 *  collapsed to a silent null, so the inspect endpoint's 503 says *why*. */
export type UiBundleResolution =
  | { kind: "ok"; path: string }
  | { kind: "inline"; html: Buffer }
  | { kind: "unavailable"; reason: string };

/** Resolve the on-demand single-file debug UI, first hit wins so local
 *  development never touches the network:
 *
 *    1. `TELO_DEBUG_UI_PATH`         — explicit override (any local build).
 *    2. devDep on disk               — present in the monorepo, absent in a
 *                                      production install.
 *    3. `<cacheRoot>/debug-ui/<ver>` — a previous fetch.
 *    4. CDN (jsDelivr / `TELO_DEBUG_UI_URL`) — fetch the pinned version. Cached
 *                                      to disk when `cacheWrite` is set; under
 *                                      `--no-cache-write` (e.g. the k8s runner's
 *                                      baked, read-only `/telo-cache`) the bytes
 *                                      are returned in-memory instead of written.
 *
 *  When nothing resolves the inspect endpoint still works headless; the returned
 *  `reason` explains the gap (missing version, no cache dir, or a failed fetch
 *  with its URL and status) so the failure is never silent.
 */
export async function resolveUiBundle(
  cacheRoot: string | null,
  cacheWrite = true,
): Promise<UiBundleResolution> {
  const override = process.env.TELO_DEBUG_UI_PATH;
  if (override) {
    if (fs.existsSync(override)) return { kind: "ok", path: override };
    return {
      kind: "unavailable",
      reason: `TELO_DEBUG_UI_PATH is set to '${override}', but no file exists there.`,
    };
  }

  try {
    const resolved = require.resolve(`${UI_PACKAGE}/${UI_ASSET}`);
    if (fs.existsSync(resolved)) return { kind: "ok", path: resolved };
  } catch {
    // Not installed (production CLI strips the devDep) — fall through to fetch.
  }

  const version = pinnedUiVersion();
  if (!version) {
    return {
      kind: "unavailable",
      reason: `cannot determine which ${UI_PACKAGE} version to fetch — set TELO_DEBUG_UI_VERSION or TELO_DEBUG_UI_PATH.`,
    };
  }
  if (!cacheRoot) {
    return { kind: "unavailable", reason: "no cache directory is available to store the fetched debug UI." };
  }

  const cached = path.join(cacheRoot, "debug-ui", version, "index.html");
  if (fs.existsSync(cached)) return { kind: "ok", path: cached };

  const base = process.env.TELO_DEBUG_UI_URL ?? DEFAULT_CDN_BASE;
  const url = `${base}/${UI_PACKAGE}@${version}/${UI_ASSET}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return { kind: "unavailable", reason: `could not fetch the debug UI from ${url} — HTTP ${res.status} ${res.statusText}.` };
    }
    const body = Buffer.from(await res.arrayBuffer());
    // `--no-cache-write`: the cache dir is read-only (e.g. the k8s runner's baked
    // `/telo-cache`), so serve the freshly fetched bytes from memory rather than
    // attempting a write that would fail (EROFS / ENOENT) and lose a good fetch.
    if (!cacheWrite) return { kind: "inline", html: body };
    await fsp.mkdir(path.dirname(cached), { recursive: true });
    await fsp.writeFile(cached, body);
    return { kind: "ok", path: cached };
  } catch (err) {
    return { kind: "unavailable", reason: `could not fetch the debug UI from ${url} — ${(err as Error).message}.` };
  }
}
