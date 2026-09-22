import * as fs from "node:fs";
import * as path from "node:path";
import type { ModuleFileClaim } from "@telorun/analyzer";
import { selectFiles } from "./select-files.js";

/**
 * Replace every claim that may name a directory (`!module-path`) with the files
 * it holds, so everything downstream — the layer partition, the packaged copy —
 * keeps dealing in files alone.
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
    if (!stat) {
      problems.push(`${claim.origin}: nothing at '${claim.path}' (MODULE_PATH_NOT_FOUND)`);
      continue;
    }
    if (!stat.isDirectory()) {
      out.push({ role: "assets", path: claim.path, origin: claim.origin });
      continue;
    }
    const files = selectFiles(manifestDir, [`${claim.path}/**`], { links: true });
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
