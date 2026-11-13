/**
 * A unit's declared `payload:` — patterns, or a command printing the paths — as
 * one more layer, digested under unit-relative names. The planner's own
 * bookkeeping (`.changes/`) is never part of it, whichever form selects it.
 *
 * A command runs in the unit's directory and prints one unit-relative path per
 * line. A non-zero exit, a path naming no file, a path printed twice, or one
 * leaving the workspace fails the plan: a payload that cannot be read exactly is
 * one whose digest would say nothing.
 */

import { selectByPatterns, GLOB_PRUNE_DIRS } from "@telorun/glob";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedUnit } from "../units.js";
import { digestFileSet, isBookkeeping, listFiles, readFileSetEntry } from "./files-digest.js";

export class PayloadError extends Error {}

export interface DeclaredPayload {
  readonly digest: string;
  /** Workspace-relative. */
  readonly files: readonly string[];
}

export function declaredPayload(root: string, unit: ResolvedUnit): DeclaredPayload {
  const spec = unit.payload!;
  const unitDir = path.join(root, unit.dir);
  const selected = "patterns" in spec
    ? [...selectByPatterns(listFiles(unitDir, GLOB_PRUNE_DIRS), [...spec.patterns], { applyDefaultIgnore: false })]
    : commandPaths(root, unit, spec.command);
  const fromRoot = (file: string) => path.relative(root, path.join(unitDir, file)).split(path.sep).join("/");
  const relative = selected.filter((file) => !isBookkeeping(fromRoot(file)));
  const entries = relative.map((file) => readFileSetEntry(unitDir, file, file));
  return { digest: digestFileSet(entries), files: relative.map(fromRoot).sort() };
}

function commandPaths(root: string, unit: ResolvedUnit, command: string): string[] {
  const unitDir = path.join(root, unit.dir);
  const where = `unit '${unit.key}' payload command \`${command}\``;
  const run = spawnSync(command, { cwd: unitDir, shell: true, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (run.error) throw new PayloadError(`${where} could not start: ${run.error.message}`);
  if (run.status !== 0) {
    throw new PayloadError(
      `${where} exited ${run.status ?? `on ${run.signal}`}${run.stderr.trim() ? `: ${run.stderr.trim()}` : ""}`,
    );
  }
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of run.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const posix = line.replace(/\\/g, "/").replace(/^\.\//, "");
    const abs = path.resolve(unitDir, posix);
    const fromRoot = path.relative(root, abs);
    if (path.isAbsolute(posix) || fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) {
      throw new PayloadError(`${where} printed '${line}', which is outside the workspace.`);
    }
    if (seen.has(posix)) throw new PayloadError(`${where} printed '${line}' twice.`);
    seen.add(posix);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      throw new PayloadError(`${where} printed '${line}', which names no file.`);
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new PayloadError(`${where} printed '${line}', which is not a file.`);
    }
    paths.push(posix);
  }
  return paths.sort();
}
