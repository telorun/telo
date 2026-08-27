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
 * `modules:` is release scope and is read by `telo release` alone, which never
 * runs in a session. It is written anyway because an empty list is a hard error
 * in the parser, and a file this repo's own tooling would reject is not one to
 * seed into a user's workspace.
 */
export const WORKSPACE_MARKER_CONTENTS = `# Marks the root of this session's workspace.
#
# The Telo kernel anchors its module cache (.telo) at the directory holding this
# file, so every application in this workspace resolves its imports once into one
# cache instead of once per app.
modules: ["*"]
`;

/**
 * The marker, unless the workspace already brings its own. A user whose project
 * really is a Telo workspace has a marker with a real \`modules:\` list, and
 * overwriting it would silently change what \`telo release\` discovers.
 */
export function workspaceMarkerWrite(
  bundle: RunBundle,
): NonNullable<WorkspaceChangeSet["write"]> {
  const provided = bundle.files.some((f) => f.relativePath === WORKSPACE_MARKER_FILENAME);
  if (provided) return [];
  return [{ path: WORKSPACE_MARKER_FILENAME, content: WORKSPACE_MARKER_CONTENTS }];
}
