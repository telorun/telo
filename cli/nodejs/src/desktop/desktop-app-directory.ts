import * as os from "node:os";
import * as path from "node:path";

/**
 * The per-user application directory of one desktop application, by its
 * `identifier`: `$XDG_DATA_HOME/<id>` (else `~/.local/share/<id>`),
 * `~/Library/Application Support/<id>` or `%LOCALAPPDATA%\<id>`. `desktop-host/`
 * beneath it belongs to the desktop host, `state/` to the kernel
 * (`TELO_HOST_STATE_DIR`). A packaged app and `telo run` of its manifest share
 * both, which is what makes the lock and the origin one per application.
 *
 * `null` when the platform's anchor (`HOME`, `LOCALAPPDATA`) is unset: the
 * caller refuses, never picks a directory the user did not choose.
 */

export interface AppDirectoryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Replaces `os.homedir()`, which ignores `HOME` on Windows. */
  home?: string;
}

export function userAppDirectory(identifier: string, options: AppDirectoryOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === "win32") {
    const local = env.LOCALAPPDATA?.trim();
    return local ? path.win32.join(local, identifier) : null;
  }
  const home = (options.home ?? env.HOME?.trim()) || safeHomedir();
  if (platform === "darwin") {
    return home ? path.posix.join(home, "Library", "Application Support", identifier) : null;
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  // The XDG base directory spec ignores a relative value.
  if (xdg && path.posix.isAbsolute(xdg)) return path.posix.join(xdg, identifier);
  return home ? path.posix.join(home, ".local", "share", identifier) : null;
}

/** The desktop host's own directory: the lock socket, `port`, the webview store. */
export function desktopHostDirectory(appDirectory: string): string {
  return path.join(appDirectory, "desktop-host");
}

/** The kernel's directory: its `TELO_HOST_STATE_DIR`. */
export function stateDirectory(appDirectory: string): string {
  return path.join(appDirectory, "state");
}

function safeHomedir(): string | undefined {
  try {
    return os.homedir() || undefined;
  } catch {
    return undefined;
  }
}
