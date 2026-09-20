import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Where a running `telo runner` keeps its session workspaces.
 *
 * Two properties the docker backend got from a named volume and a local
 * directory does not get for free:
 *
 *  - **It is private.** A session workspace holds the user's source, and a
 *    directory created under the system temp directory with the default mode is
 *    readable by every account on the machine. Both levels are created `0o700`
 *    and chmod'ed afterwards, because `mkdir`'s mode is masked by the process
 *    umask while `chmod` is not.
 *  - **It is reclaimed.** Sessions are removed as they stop, but a runner that
 *    is killed (`SIGKILL`, a crash, a machine losing power) leaves whole source
 *    trees behind with nothing that knows about them. So each runner owns a
 *    subdirectory named by its PID, and every runner sweeps the ones whose
 *    process is gone on the way up. The PID is what makes "gone" a question with
 *    an answer, rather than a timestamp heuristic that eventually deletes a live
 *    session's files.
 */

/** This process's own session directory under `stateRoot`. */
export function ownStateRoot(stateRoot: string): string {
  return path.join(stateRoot, String(process.pid));
}

export interface StateRootPreparation {
  /** The directory this runner stages sessions in. */
  ownRoot: string;
  /** Directories left by runners that are no longer running, removed. */
  swept: string[];
}

export async function prepareStateRoot(stateRoot: string): Promise<StateRootPreparation> {
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(stateRoot, 0o700);

  const swept: string[] = [];
  for (const entry of await fs.readdir(stateRoot, { withFileTypes: true })) {
    // Anything not named by a PID belongs to something else; leaving it alone
    // is the only safe reading of a directory this runner did not create.
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (pid === process.pid || isRunning(pid)) continue;
    await fs.rm(path.join(stateRoot, entry.name), { recursive: true, force: true });
    swept.push(entry.name);
  }

  const ownRoot = ownStateRoot(stateRoot);
  await fs.mkdir(ownRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(ownRoot, 0o700);
  return { ownRoot, swept };
}

/** Remove this runner's own directory. Best-effort: the sweep above is what
 *  covers the case where this never runs. */
export async function releaseStateRoot(stateRoot: string): Promise<void> {
  await fs.rm(ownStateRoot(stateRoot), { recursive: true, force: true }).catch(() => {
    /* a leftover is reclaimed by the next runner's sweep */
  });
}

/** Whether a PID names a live process. `EPERM` means it exists and belongs to
 *  somebody else, which is still alive — only `ESRCH` is gone. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
