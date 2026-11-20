/**
 * The revisions a module's `sources:` block declares, each checked against the
 * history of the repository it names before anything is published from it or
 * any audit relies on it: a revision OSV is asked about must be a commit of the
 * repository whose advisories are read, never a commit the host merely serves.
 */

import { teloFormatFailure, type ModuleSource, type SourceVcs } from "@telorun/analyzer";
import { CommitHistoryReader, repositoryAddress, RepositoryUnreadableError } from "./commit-history.js";

export const SOURCE_REVISION_UNREACHABLE = "SOURCE_REVISION_UNREACHABLE";
export const SOURCE_REPOSITORY_UNREADABLE = "SOURCE_REPOSITORY_UNREADABLE";

/** One `vcs:` a module declares, where it is written. */
export interface DeclaredRevision {
  /** `sources.<name>` or `sources.<name>.contains[<i>]`: the declaration holding `vcs`. */
  readonly at: string;
  readonly purl: string;
  readonly version: string;
  readonly vcs: SourceVcs;
}

export interface RevisionFinding {
  readonly code: typeof SOURCE_REVISION_UNREACHABLE | typeof SOURCE_REPOSITORY_UNREADABLE;
  /** The `vcs.revision` the finding is anchored at. */
  readonly path: string;
  readonly message: string;
  readonly revision: DeclaredRevision;
}

/** Every `vcs:` the sources declare whose url and revision are in their formats
 *  (one that is not is `telo check`'s to report). */
export function declaredRevisions(sources: readonly ModuleSource[]): DeclaredRevision[] {
  const found: DeclaredRevision[] = [];
  const add = (at: string, purl: string | undefined, version: string, vcs: SourceVcs | undefined) => {
    if (!purl || !vcs || teloFormatFailure("vcs-url", vcs.url) || teloFormatFailure("vcs-revision", vcs.revision)) return;
    found.push({ at, purl, version, vcs });
  };
  for (const source of sources) {
    add(`sources.${source.name}`, source.purl, source.version, source.vcs);
    source.contains.forEach((item, index) => add(`sources.${source.name}.contains[${index}]`, item.purl, item.version, item.vcs));
  }
  return found;
}

/** The revisions no branch or tag of their repository reaches, and those whose
 *  repository gave no history, each worded at its `vcs.revision`. */
export async function checkDeclaredRevisions(
  revisions: readonly DeclaredRevision[],
  reader: CommitHistoryReader,
): Promise<RevisionFinding[]> {
  const findings: RevisionFinding[] = [];
  for (const revision of revisions) {
    const path = `${revision.at}.vcs.revision`;
    const address = repositoryAddress(revision.vcs.url);
    try {
      if (await reader.reachable(revision.vcs.url, revision.vcs.revision)) continue;
      findings.push({
        code: SOURCE_REVISION_UNREACHABLE,
        path,
        revision,
        message:
          `${path} ${revision.vcs.revision} is not reachable from any branch or tag of ${address}. ` +
          `Write the commit the staged files were built from, and the repository whose history holds it.`,
      });
    } catch (error) {
      if (!(error instanceof RepositoryUnreadableError)) throw error;
      findings.push({
        code: SOURCE_REPOSITORY_UNREADABLE,
        path,
        revision,
        message:
          `${error.host} gave no history of ${address} to check ${path} ${revision.vcs.revision} ` +
          `against: ${error.detail}. Point ${revision.at}.vcs.url at a mirror that serves the ` +
          `repository's history, or remove vcs to leave the component unchecked.`,
      });
    }
  }
  return findings;
}
