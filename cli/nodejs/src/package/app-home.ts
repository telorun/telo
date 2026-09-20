import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Where a packaged application unpacks itself, and where the packager caches
 * the carriers it downloads.
 *
 * Both are the user's cache, because both are reconstructible: an unpacked tree
 * comes back out of the binary that owns it, and a carrier comes back off the
 * release. Nothing here is state.
 */

/** Relocates the whole root. The one knob a hardened deployment has, since a
 *  packaged app's argv belongs to the application. */
export const APP_DIR_ENV = "TELO_APP_DIR";

/** Prints the payload index and exits, before the application is loaded. */
export const APP_INFO_ENV = "TELO_APP_INFO";

/** The user cache root, in each platform's own convention. `null` when none of
 *  them is usable, which a caller answers with a temporary directory or a
 *  refusal — never by picking a directory the user did not choose. */
export function userCacheRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env[APP_DIR_ENV]?.trim();
  if (override) return path.resolve(override);
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA?.trim();
    return local ? path.join(local, "telo") : null;
  }
  if (process.platform === "darwin") {
    const home = env.HOME?.trim();
    return home ? path.join(home, "Library", "Caches", "telo") : null;
  }
  const xdg = env.XDG_CACHE_HOME?.trim();
  if (xdg) return path.join(xdg, "telo");
  const home = env.HOME?.trim();
  return home ? path.join(home, ".cache", "telo") : null;
}

/** A directory under the cache root that this process can actually write, or
 *  `null`. The write is attempted rather than inferred: a read-only mount, a
 *  root-owned cache and a missing `HOME` are all ordinary deployments and none
 *  of them is discoverable from the path alone. */
export function writableDir(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // `mkdir`'s mode is masked by the umask, so the private bit is set rather
    // than requested — the app's own source lives here.
    fs.chmodSync(dir, 0o700);
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch {
    return null;
  }
}

/** Where packaged applications unpack: `<cache root>/apps`, else a temporary
 *  directory, else `null` — a hardened container with a read-only root and no
 *  tmpfs has nowhere at all, and the caller says so naming `TELO_APP_DIR`. */
export function appsRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = userCacheRoot(env);
  if (root) {
    const dir = writableDir(path.join(root, "apps"));
    if (dir) return dir;
  }
  try {
    return writableDir(path.join(fs.realpathSync(os.tmpdir()), "telo-apps"));
  } catch {
    return null;
  }
}

/** Where downloaded carriers are kept between packagings. */
export function carriersRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = userCacheRoot(env);
  if (!root) return null;
  return writableDir(path.join(root, "carriers"));
}
