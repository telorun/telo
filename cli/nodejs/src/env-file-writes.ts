import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "./logger.js";
import { outErrLine } from "./output.js";

/**
 * What every command writing an application's env files shares — `telo env
 * template --write` and the values `telo run` offers to save: reading a file
 * that may not exist yet, and the warning for a sensitive file a repository
 * would commit. Which file a value goes to is the analyzer's
 * `envFileDestination`, and how it is spelled its `spellEnvFileValue`.
 */

export function readEnvFileIfPresent(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** A sensitive file holds secrets, so a repository that would commit it is
 *  worth a warning. Outside a repository there is nothing to commit it into,
 *  and nothing is said. */
export function warnIfNotIgnored(file: string, log: Logger): void {
  const cwd = path.dirname(file);
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8" });
  if (inside.error || inside.status !== 0) return;
  const ignored = spawnSync("git", ["check-ignore", "-q", path.basename(file)], { cwd, encoding: "utf8" });
  if (ignored.status === 0) return;
  const shown = path.relative(process.cwd(), file) || file;
  outErrLine(
    ignored.status === 1
      ? `${log.err.warn("warning")}  ${shown} is not ignored by git, and it holds secrets — add it to .gitignore.`
      : `${log.err.warn("warning")}  could not ask git whether ${shown} is ignored: ${ignored.stderr.trim() || `exit ${ignored.status}`}`,
  );
}
