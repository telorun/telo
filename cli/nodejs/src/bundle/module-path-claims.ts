import * as fs from "node:fs";
import * as path from "node:path";
import { pathsAtOrBeneath, type ModuleFileClaim } from "@telorun/analyzer";
import { selectFiles } from "./select-files.js";

/**
 * Replace every claim that may name a directory (`!module-path`) with the files
 * it holds, so everything downstream — the layer partition, the packaged copy —
 * keeps dealing in files alone.
 *
 * `staged` lists the module files a `sources:` entry stages that ship from their
 * pins rather than from disk (`stagedModuleFiles`; empty when the payload reads
 * staged files from disk). Such a file is present whether or not it is on disk,
 * and a directory holds the staged files beneath it as well as what is there.
 *
 * A claim naming nothing is refused (`MODULE_PATH_NOT_FOUND`): the artifact
 * would ship without what the manifest points at, and the resource holding it
 * would fail on someone else's machine. So is a directory with no files in it
 * (`MODULE_PATH_EMPTY`) — a layer carries files and links, so an empty one
 * cannot travel at all.
 */
export function expandDirectoryClaims(
  manifestDir: string,
  claims: readonly ModuleFileClaim[],
  staged: readonly string[],
): ModuleFileClaim[] {
  const out: ModuleFileClaim[] = [];
  const problems: string[] = [];
  for (const claim of claims) {
    if (claim.role !== "assets" || !claim.directory) {
      out.push(claim);
      continue;
    }
    const target = path.join(manifestDir, claim.path);
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    const stagedHere = pathsAtOrBeneath(staged, claim.path);
    if (!stat && stagedHere.length === 0) {
      problems.push(`${claim.origin}: nothing at '${claim.path}' (MODULE_PATH_NOT_FOUND)`);
      continue;
    }
    if (stat ? !stat.isDirectory() : stagedHere.includes(claim.path)) {
      out.push({ role: "assets", path: claim.path, origin: claim.origin });
      continue;
    }
    const onDisk = stat ? selectFiles(manifestDir, [`${claim.path}/**`], { links: true }) : [];
    const files = [...new Set([...onDisk, ...stagedHere])].sort();
    if (files.length === 0) {
      problems.push(`${claim.origin}: '${claim.path}' holds no files (MODULE_PATH_EMPTY)`);
      continue;
    }
    for (const file of files) out.push({ role: "assets", path: file, origin: claim.origin });
  }
  if (problems.length > 0) {
    throw new Error(
      `Module '${path.basename(manifestDir)}' names locations that cannot ship:\n` +
        problems.map((line) => `  ${line}`).join("\n"),
    );
  }
  return out;
}
