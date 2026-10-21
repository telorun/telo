import { createRequire } from "node:module";
import { APP_CLI_ENV } from "../app-cli-switch.js";
import { carriesPayload } from "../package/app-trailer.js";

/**
 * How to spawn THIS telo again.
 *
 * The local runner supervises `telo run --watch`, and which `telo` that is
 * decides the debug-wire generation, the workspace-marker semantics and the run
 * flags the supervisor depends on. Resolving one from `PATH` would make those
 * answers a property of the machine — a second install, at another version,
 * silently driving a session this process is interpreting. The running
 * executable is the only one that is right by construction.
 *
 * Two distributions, two shapes: a single-file executable IS the command, while
 * an npm install is a script Node runs. `process.argv[1]` is that script as it
 * was actually invoked (`bin/telo.mjs` on PATH, `dist/cli.js` under a package
 * script), which is what keeps a dev checkout and an installed package the same
 * code path.
 *
 * An executable carrying an application is that application unless
 * `TELO_APP_CLI=1` says otherwise — and every telo start removes the variable
 * from its own environment, so a child inherits none. Re-running such an
 * executable as telo therefore hands the variable to the child explicitly.
 */
export interface SelfInvocation {
  command: string;
  /** Arguments that must precede the telo arguments (empty for a binary). */
  prefix: string[];
  /** Environment the command needs to be the telo CLI, set over the child's
   *  own — `TELO_APP_CLI=1` for an executable carrying an application. */
  env: Record<string, string>;
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
export interface RunningTelo {
  readonly singleFileExecutable: boolean;
  readonly execPath: string;
  readonly script: string | undefined;
}

export async function selfInvocation(
  running: RunningTelo = {
    singleFileExecutable: isSingleFileExecutable(),
    execPath: process.execPath,
    script: process.argv[1],
  },
): Promise<SelfInvocation> {
  const env: Record<string, string> = (await carriesPayload(running.execPath))
    ? { [APP_CLI_ENV]: "1" }
    : {};
  if (running.singleFileExecutable) {
    return { command: running.execPath, prefix: [], env };
  }
  if (!running.script) {
    // Nothing to re-enter: refused rather than guessed, because every guess
    // here ends as a session that runs some other telo.
    throw new Error(
      "the runner cannot determine how to re-invoke telo: this process was started with no script path",
    );
  }
  return { command: running.execPath, prefix: [running.script], env };
}
