import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Where a `telo runner` keeps what outlives its process — its state root: the
 * session store (`sessions.sqlite`, beside this layout) and one directory per session under
 * `sessions/<sessionId>/`, holding `workspace/` (the application's files and its
 * `.telo` module cache) and `agent/` (a co-resident agent's state).
 *
 *  - **It is private.** A session directory holds the user's source, and one
 *    created under the system temp directory with the default mode is readable
 *    by every account on the machine. Every level is created `0o700` and
 *    chmod'ed afterwards, because `mkdir`'s mode is masked by the umask while
 *    `chmod` is not.
 *  - **It is kept by session id.** A session's directory survives suspend and
 *    runner restarts, and goes only when its session is deleted or retention
 *    removes it. The boot sweep removes exactly the session directories the
 *    store does not know — the store is what makes "abandoned" a question with
 *    an answer.
 */

const SESSIONS = "sessions";

/** Names the whole state directory on every runner. */
export const STATE_DIR_ENV = "RUNNER_STATE_DIR";

export type StateRootResolution =
  | { root: string; from: "--state-dir" | typeof STATE_DIR_ENV | "default" }
  | { refusal: string };

/**
 * The ONE state root of a local runner: `--state-dir`, then `RUNNER_STATE_DIR`,
 * then the per-user directory each platform keeps application state in. Never
 * the temp directory, which a reboot or a cleaner empties, and never the CLI's
 * cache root, which is reconstructible by definition — a session's files are
 * neither. With no default to fall back on the answer is a refusal.
 */
export function resolveStateRoot(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  cwd: string,
): StateRootResolution {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const given = flag?.trim();
  if (given) return { root: paths.resolve(cwd, given), from: "--state-dir" };
  const named = env[STATE_DIR_ENV]?.trim();
  if (named) return { root: paths.resolve(cwd, named), from: STATE_DIR_ENV };
  const fallback = platformStateRoot(env, platform, paths);
  if ("root" in fallback) return { root: fallback.root, from: "default" };
  return {
    refusal:
      `no state directory: ${fallback.missing}, so there is no per-user default. ` +
      `Name one with --state-dir <dir> or ${STATE_DIR_ENV}.`,
  };
}

function platformStateRoot(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  paths: path.PlatformPath,
): { root: string } | { missing: string } {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA?.trim();
    return local
      ? { root: paths.join(local, "telo", "state", "runner") }
      : { missing: "LOCALAPPDATA is not set" };
  }
  const home = env.HOME?.trim();
  if (platform === "darwin") {
    return home
      ? { root: paths.join(home, "Library", "Application Support", "telo", "runner") }
      : { missing: "HOME is not set" };
  }
  // The XDG spec ignores a relative value.
  const xdg = env.XDG_STATE_HOME?.trim();
  if (xdg && paths.isAbsolute(xdg)) return { root: paths.join(xdg, "telo", "runner") };
  return home
    ? { root: paths.join(home, ".local", "state", "telo", "runner") }
    : { missing: "HOME is not set and XDG_STATE_HOME names no absolute directory" };
}

export interface SessionDirectory {
  root: string;
  workspace: string;
  agent: string;
}

export function sessionDirectory(stateRoot: string, sessionId: string): SessionDirectory {
  const root = path.join(stateRoot, SESSIONS, sessionId);
  return { root, workspace: path.join(root, "workspace"), agent: path.join(root, "agent") };
}

/** The state root and its `sessions/` level, private to this user and
 *  writable by this process. */
export async function prepareStateRoot(stateRoot: string): Promise<void> {
  await privateDirectory(stateRoot);
  await privateDirectory(path.join(stateRoot, SESSIONS));
  await fs.access(stateRoot, fsConstants.W_OK);
}

/** A session's directories, created on first use and left as they are after. */
export async function createSessionDirectory(
  stateRoot: string,
  sessionId: string,
): Promise<SessionDirectory> {
  const dir = sessionDirectory(stateRoot, sessionId);
  await privateDirectory(dir.root);
  await privateDirectory(dir.workspace);
  await privateDirectory(dir.agent);
  return dir;
}

export async function removeSessionDirectory(stateRoot: string, sessionId: string): Promise<void> {
  await fs.rm(sessionDirectory(stateRoot, sessionId).root, { recursive: true, force: true });
}

/** Remove every session directory whose session the store does not know, and
 *  return their names. Everything under `sessions/` is the runner's own. */
export async function sweepSessionDirectories(
  stateRoot: string,
  known: ReadonlySet<string>,
): Promise<string[]> {
  const sessions = path.join(stateRoot, SESSIONS);
  const swept: string[] = [];
  for (const entry of await fs.readdir(sessions, { withFileTypes: true })) {
    if (known.has(entry.name)) continue;
    await fs.rm(path.join(sessions, entry.name), { recursive: true, force: true });
    swept.push(entry.name);
  }
  return swept;
}

async function privateDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}
