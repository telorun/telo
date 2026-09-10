import type { RunBundle, WorkspaceChangeSet } from "../contract.js";

/** The kernel anchors its `.telo` cache at the directory holding this file. */
export const WORKSPACE_MARKER_FILENAME = "telo-workspace.yaml";

/**
 * The marker a session's workspace root carries.
 *
 * Its LOCATION is what matters here: the kernel walks up from an app's entry
 * manifest looking for it and anchors the `.telo` cache at the directory that
 * holds it. Without one, each app anchors on its OWN entry directory, so two
 * apps in one workspace resolve the same module twice into two caches — and an
 * app in a subdirectory gets a third.
 *
 * **It declares no blocks.** Every field of the marker sits in a block scoped to
 * the command that reads it, and a session runs none of them: `release:` is
 * versioning and publishing, which never happens here. This used to write
 * `modules: ["*"]` — release scope a session has no use for — purely because an
 * empty list was a parse error, so the runner shipped a fabricated claim into
 * every user's workspace to satisfy a reader that was never going to run.
 */
export const WORKSPACE_MARKER_CONTENTS = `# Marks the root of this session's workspace.
#
# The Telo kernel anchors its module cache (.telo) at the directory holding this
# file, so every application in this workspace resolves its imports once into one
# cache instead of once per app. It also bounds the walk that collects .env and
# .env.local for a run.
#
# Nothing else is declared: 'release:' (where modules live, and where they
# publish) is read by \`telo release\`, which does not run in a session.
`;

/**
 * The marker, unless the workspace already brings its own. A user whose project
 * really is a Telo workspace has a marker with a real \`release.modules\` list,
 * and overwriting it would silently change what \`telo release\` discovers.
 */
export function workspaceMarkerWrite(
  bundle: RunBundle,
): NonNullable<WorkspaceChangeSet["write"]> {
  const provided = bundle.files.some((f) => f.relativePath === WORKSPACE_MARKER_FILENAME);
  if (provided) return [];
  return [{ path: WORKSPACE_MARKER_FILENAME, content: WORKSPACE_MARKER_CONTENTS }];
}
