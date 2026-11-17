import { createRequire } from "node:module";

/**
 * How to spawn THIS telo again.
 *
 * The host runner supervises `telo run --watch`, and which `telo` that is
 * decides the debug-wire generation, the workspace-marker semantics and the run
 * flags the supervisor depends on. Resolving one from `PATH` would make those
 * answers a property of the machine — a second install, at another version,
 * silently driving a session this process is interpreting. The running
 * executable is the only one that is right by construction, and it IS a telo:
 * its entry hands a leading `telo` to the bundled CLI, so the runner re-enters
 * itself as `telo-host-runner telo <arguments>`.
 *
 * Two distributions, two shapes: a single-file executable IS the command, while
 * an npm install is a script Node runs. `process.argv[1]` is that script as it
 * was actually invoked, which keeps a dev checkout and an installed package the
 * same code path.
 */
export interface SelfInvocation {
  command: string;
  /** Arguments that must precede the telo arguments: the script of an npm
   *  install and the `telo` that selects the CLI. Empty for a release binary,
   *  which is telo as it stands. */
  prefix: string[];
}

function isSingleFileExecutable(): boolean {
  try {
    const sea = createRequire(import.meta.url)("node:sea") as { isSea(): boolean };
    return sea.isSea();
  } catch {
    // A Node without `node:sea` cannot be running a single-file executable.
    return false;
  }
}

/** The running process, as far as re-invoking it is concerned. */
export interface RunningRunner {
  readonly singleFileExecutable: boolean;
  readonly execPath: string;
  readonly script: string | undefined;
}

export async function selfInvocation(
  running: RunningRunner = {
    singleFileExecutable: isSingleFileExecutable(),
    execPath: process.execPath,
    script: process.argv[1],
  },
): Promise<SelfInvocation> {
  if (running.singleFileExecutable) {
    return { command: running.execPath, prefix: [TELO_ARGUMENT] };
  }
  if (!running.script) {
    // Nothing to re-enter: refused rather than guessed, because every guess
    // here ends as a session that runs some other telo.
    throw new Error(
      "the runner cannot determine how to re-invoke itself: this process was started with no script path",
    );
  }
  return { command: running.execPath, prefix: [running.script, TELO_ARGUMENT] };
}

/** The leading argument the entry hands to the bundled CLI. */
export const TELO_ARGUMENT = "telo";
