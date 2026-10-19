/**
 * The env files a run reads — the Node half.
 *
 * The walk, the marker's `env:` block, the precedence, the format and the
 * sensitive mark are the analyzer's (`resolveWorkspaceEnv`), one answer shared
 * with Studio. What is left here is what only a Node host knows: the start
 * directory (a manifest's, or the directory named, through symbolic links so
 * the walk climbs the real tree), the one read every file goes through, and the
 * conversion between native paths and the `/`-separated ones the analyzer
 * speaks. No ceiling: a run may find a marker anywhere above it.
 *
 * Only absence is silent. A file that exists and cannot be read — a root-owned
 * `.env.local` in a shared checkout, a directory where a file is expected — is
 * reported by the resolution, because the alternative is an app booting without
 * a variable the developer can see in the file.
 */

import { resolveWorkspaceEnv, type EnvFileRead, type WorkspaceEnvResolution } from "@telorun/analyzer";
import * as fs from "node:fs";
import * as path from "node:path";
import { realPath } from "./workspace-marker.js";

/**
 * Resolve the env files visible from `anchor` — a manifest, or the directory a
 * walk starts at. Reads the filesystem and returns what it found; applies and
 * prints nothing.
 */
export function resolveEnvFiles(anchor: string): Promise<WorkspaceEnvResolution> {
  return resolveWorkspaceEnv({ start: toWorkspacePath(anchorDirectory(anchor)), read: readFile });
}

/** A path from a resolution, in the host's own spelling. */
export function nativePath(workspacePath: string): string {
  return path.sep === "/" ? workspacePath : workspacePath.split("/").join(path.sep);
}

function toWorkspacePath(native: string): string {
  return path.sep === "/" ? native : native.split(path.sep).join("/");
}

/** The anchor itself when it names a directory, else the directory holding it. */
function anchorDirectory(anchor: string): string {
  const resolved = realPath(path.resolve(anchor));
  return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
}

async function readFile(file: string): Promise<EnvFileRead> {
  try {
    return { kind: "text", text: await fs.promises.readFile(nativePath(file), "utf8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    if (code === "EISDIR") return { kind: "not-a-file" };
    return { kind: "unreadable", reason: code ?? String(err) };
  }
}
