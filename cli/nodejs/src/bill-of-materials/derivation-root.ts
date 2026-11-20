import * as path from "node:path";

/**
 * The artifact root a local module would be published in: the entry's, when
 * its manifest sits under the entry's directory, else the outermost local
 * module whose directory holds it — so an input in that tree is the module's
 * own code, as `telo publish` attributes it.
 */
export function derivationRoot(manifestPath: string, entryDir: string, locals: readonly string[]): string | undefined {
  const inside = (dir: string, file: string): boolean => {
    const rel = path.relative(dir, path.dirname(file));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  const entry = locals[0];
  if (entry && inside(entryDir, manifestPath)) return entry;
  const holders = locals
    .filter((candidate) => inside(path.dirname(candidate), manifestPath))
    .sort((a, b) => path.dirname(a).length - path.dirname(b).length || a.localeCompare(b));
  return holders[0];
}
