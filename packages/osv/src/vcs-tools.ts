/**
 * The version control tools OSV matches commits of, as data: the tool a VCS
 * location names (`git` of `git+https://…`) to the OSV ecosystem its
 * repositories are recorded under. A component built from a repository of a tool
 * absent here is never judged clean by its revision.
 */
import { normalizeRepository } from "./repository-address.js";

export const OSV_VCS_ECOSYSTEMS: Readonly<Record<string, string>> = {
  git: "GIT",
};

/** The tool of a VCS location (`git` of `git+https://github.com/acme/engine`), lower-cased. */
export function vcsTool(url: string): string | undefined {
  const match = /^([A-Za-z][A-Za-z0-9.-]*)\+/.exec(url);
  return match ? match[1]!.toLowerCase() : undefined;
}

/** The repository a VCS location names, as OSV records it: the location without its
 *  `<tool>+`, normalized as {@link sameRepository} compares. */
export function vcsRepository(url: string): string {
  const tool = /^[A-Za-z][A-Za-z0-9.-]*\+/.exec(url);
  return normalizeRepository(tool ? url.slice(tool[0].length) : url);
}

/** The OSV ecosystem a VCS location's repository is recorded under, or undefined
 *  when OSV matches no commit of its tool. */
export function vcsEcosystem(url: string): string | undefined {
  const tool = vcsTool(url);
  return tool !== undefined && Object.hasOwn(OSV_VCS_ECOSYSTEMS, tool) ? OSV_VCS_ECOSYSTEMS[tool] : undefined;
}

/** Two repository addresses compared the way OSV writes them: no trailing `/` or `.git`, host case-insensitive. */
export function sameRepository(a: string, b: string): boolean {
  return normalizeRepository(a) === normalizeRepository(b);
}
