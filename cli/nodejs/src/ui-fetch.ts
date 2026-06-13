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

/** The `@telorun/debug-ui` version this CLI was published against. In the
 *  monorepo the pin is `workspace:*` (no concrete version) — but there the devDep
 *  resolves on disk, so this is only consulted for the cache/fetch paths an end
 *  user hits, where `pnpm publish` has rewritten it to an exact version. */
function pinnedUiVersion(): string | null {
  const pkg = readOwnPackageJson();
  const raw = pkg?.devDependencies?.[UI_PACKAGE] ?? pkg?.dependencies?.[UI_PACKAGE];
  if (typeof raw !== "string") return null;
  const version = raw.replace(/^[\^~>=<\s]+/, "").trim();
  return /^\d/.test(version) ? version : null;
}

/** Resolve the on-demand single-file debug UI to an absolute path, first hit
 *  wins so local development never touches the network:
 *
 *    1. `TELO_DEBUG_UI_PATH`         — explicit override (any local build).
 *    2. devDep on disk               — present in the monorepo, absent in a
 *                                      production install.
 *    3. `<cacheRoot>/debug-ui/<ver>` — a previous fetch.
 *    4. jsDelivr                     — fetch the pinned version, cache, serve.
 *
 *  Returns `null` when nothing resolves (offline + uncached): the inspect
 *  endpoint still works headless, only the served UI is absent.
 */
export async function resolveUiBundle(cacheRoot: string | null): Promise<string | null> {
  const override = process.env.TELO_DEBUG_UI_PATH;
  if (override && fs.existsSync(override)) return override;

  try {
    const resolved = require.resolve(`${UI_PACKAGE}/${UI_ASSET}`);
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    // Not installed (production CLI strips the devDep) — fall through to fetch.
  }

  const version = pinnedUiVersion();
  if (!version || !cacheRoot) return null;

  const cached = path.join(cacheRoot, "debug-ui", version, "index.html");
  if (fs.existsSync(cached)) return cached;

  const base = process.env.TELO_DEBUG_UI_URL ?? DEFAULT_CDN_BASE;
  const url = `${base}/${UI_PACKAGE}@${version}/${UI_ASSET}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = Buffer.from(await res.arrayBuffer());
    await fsp.mkdir(path.dirname(cached), { recursive: true });
    await fsp.writeFile(cached, body);
    return cached;
  } catch {
    return null;
  }
}
