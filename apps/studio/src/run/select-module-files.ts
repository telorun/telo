import type { DirEntry } from "../model";
import { expandGlobViaList } from "../loader/paths";

/**
 * Select the files a module's `files:` patterns ship, as absolute POSIX paths.
 * Thin wrapper over the shared glob expander: walks the module directory via
 * `listDir` and matches with the monorepo's single Telo-glob matcher. Unlike
 * `include:` resolution it keeps the soft default-ignore deny pass, so the run
 * bundle ships exactly what `telo publish` would.
 */
export async function selectModuleFiles(
  base: string,
  patterns: string[],
  listDir: (dir: string) => Promise<DirEntry[]>,
): Promise<string[]> {
  return expandGlobViaList(base, patterns, listDir);
}
