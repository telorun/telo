import { createRequire } from "node:module";

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
 */
export interface SelfInvocation {
  command: string;
  /** Arguments that must precede the telo arguments (empty for a binary). */
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

export function selfInvocation(): SelfInvocation {
  if (isSingleFileExecutable()) return { command: process.execPath, prefix: [] };
  const script = process.argv[1];
  if (!script) {
    // Nothing to re-enter: refused rather than guessed, because every guess
    // here ends as a session that runs some other telo.
    throw new Error(
      "the runner cannot determine how to re-invoke telo: this process was started with no script path",
    );
  }
  return { command: process.execPath, prefix: [script] };
}

/** The full argv for one `telo …` invocation of this same CLI. */
export function selfCommand(args: string[]): { command: string; args: string[] } {
  const self = selfInvocation();
  return { command: self.command, args: [...self.prefix, ...args] };
}
