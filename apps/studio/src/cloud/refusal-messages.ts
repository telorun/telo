import { CloudApiError } from "./api";
import type { Publication } from "./api";
import { CloudUnreachableError } from "./transport";

/** What a refused commit, update or branch operation tells the user. */
export function repositoryRefusalMessage(err: unknown): string {
  if (err instanceof CloudUnreachableError) {
    return `Telo Cloud could not be reached: ${err.message}`;
  }
  if (!(err instanceof CloudApiError)) return err instanceof Error ? err.message : String(err);
  switch (err.code) {
    case "session_required":
      return "You are signed out. Sign in to Telo Cloud and try again — your changes are kept.";
    case "repository_credentials_invalid":
      return "Telo Cloud can no longer access this workspace's repository. A workspace admin must reconnect it in the Telo Cloud console.";
    case "commit_too_large":
      return "This commit is too large. Commit fewer files at a time.";
    case "invalid_change": {
      const path = typeof err.problem.path === "string" ? err.problem.path : null;
      return path
        ? `Telo Cloud refused the change to ${path}.`
        : "Telo Cloud refused one of the changes.";
    }
    case "repository_too_large":
      return "The repository would exceed its size limit with this commit.";
    case "repository_quota_exceeded":
      return "This workspace's repository quota is used up.";
    case "repository_unreachable":
      return "The workspace's git host could not be reached. Try again in a moment.";
    case "overloaded":
      return "Telo Cloud is busy. Try again in a moment.";
    case "branch_exists":
      return "A branch with that name already exists.";
    case "commit_not_found":
      return "That commit is no longer in the repository.";
    case "insufficient_permission":
      return "Your role in this workspace does not allow that.";
    default:
      return err.message;
  }
}

/** What a failed publication tells the user, by its `error.code`. */
export function publicationFailureMessage(error: NonNullable<Publication["error"]>): string {
  const details = error.details ?? {};
  const named = (key: string) => (typeof details[key] === "string" ? (details[key] as string) : null);
  const importOf = () => {
    const alias = named("alias");
    const ref = named("ref");
    return alias && ref ? `'${alias}' (${ref})` : (alias ?? ref ?? "an import");
  };
  switch (error.code) {
    case "version_content_mismatch":
      return `Version ${named("version") ?? "of this module"} is already published with different content. Change metadata.version and commit before publishing again.`;
    case "sibling_not_published":
      return "This module imports modules of this workspace that are not published yet. Publish those first.";
    case "import_unpinned":
      return `The import ${importOf()} carries no integrity pin. Pin it, commit, and publish again.`;
    case "import_pin_mismatch":
      return `The import ${importOf()} is pinned to content its registry no longer serves.`;
    case "import_unreachable":
      return `The import ${importOf()} could not be reached.`;
    case "manifest_invalid":
      return "The module's manifest does not pass analysis.";
    case "version_missing":
      return "The module declares no metadata.version.";
    case "module_not_found":
      return "No telo.yaml was found at this module's path in the commit.";
    case "module_path_invalid":
      return "A module at this path cannot be published.";
    case "commit_not_found":
      return "The commit is no longer in the repository.";
    case "artifact_too_large":
      return "The published module would exceed the size limit.";
    case "repository_unreachable":
      return "The workspace's git host could not be reached.";
    case "repository_credentials_invalid":
      return "Telo Cloud can no longer access this workspace's repository. A workspace admin must reconnect it in the Telo Cloud console.";
    case "registry_unavailable":
      return "The Telo Cloud registry is unavailable. Try again later.";
    case "publish_timeout":
      return "Publishing took too long and was stopped.";
    case "publish_failed":
      return error.message ?? "Publishing failed.";
    default:
      return error.message ?? `Publishing failed (${error.code}).`;
  }
}
