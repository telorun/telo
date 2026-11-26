import type { WorkspaceBackend } from "../storage";

interface RestoreHint {
  rootDir: string | null;
  backend?: WorkspaceBackend;
}

/** How a persisted hint is brought back on load: the browser-stored workspace by
 *  its backend (its root is shared with a picked folder named `workspace`);
 *  anything else by its root, as a hint without a backend always was. */
export function restoreDecision(hint: RestoreHint | null): "browser" | "root" | "none" {
  if (!hint?.rootDir) return "none";
  return hint.backend === "browser" ? "browser" : "root";
}

/** The landing's "Recent" line for a workspace that was not restored — never
 *  the browser workspace's internal root. */
export function recentWorkspaceLabel(hint: RestoreHint | null): string | null {
  if (!hint?.rootDir) return null;
  if (hint.backend === "browser") return "Browser workspace";
  const segments = hint.rootDir.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? hint.rootDir;
}
