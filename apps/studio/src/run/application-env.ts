import {
  resolveWorkspaceEnv,
  sensitiveEnvironmentInputs,
  workspacePathRelative,
  type SensitiveEnvironmentInput,
  type WorkspaceEnvResolution,
} from "@telorun/analyzer";
import { pathDirname } from "../loader/paths";
import { workspaceFileRead } from "../loader/workspace-file-read";
import type { ParsedManifest, WorkspaceAdapter } from "../model";
import type { EnvFileProblem } from "./context";

/** A Studio path in the walk's spelling: `/`-separated on every platform. */
function walkPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * The env files visible from an Application's manifest, read through the
 * workspace's adapter: the walk `telo run` takes, except that it never climbs
 * above the opened folder — with no marker inside it, the folder is the bound.
 * Read fresh by each caller; nothing about it is kept between reads.
 */
export function resolveApplicationEnv(
  adapter: WorkspaceAdapter,
  rootDir: string,
  manifestPath: string,
): Promise<WorkspaceEnvResolution> {
  return resolveWorkspaceEnv({
    start: walkPath(pathDirname(manifestPath)),
    ceiling: walkPath(rootDir),
    read: workspaceFileRead(adapter),
  });
}

/** A file of the walk as the explorer names it: relative to the workspace root. */
export function workspaceFileOf(rootDir: string, path: string): string {
  return workspacePathRelative(walkPath(rootDir), path);
}

/** The manifest's directory joined with an `env.files` entry, as a Studio path. */
export function envFileBeside(manifestPath: string, name: string): string {
  return `${pathDirname(manifestPath)}/${name}`;
}

/**
 * Why the files cannot be the run's environment, each naming its file: a marker
 * whose `env:` is refused (or that cannot be read), or an env file that exists
 * and cannot be read. Studio has no shell to fall back on, so a value it cannot
 * read is a value the run lacks — every problem refuses the run.
 */
export function envFileProblems(
  resolution: WorkspaceEnvResolution,
  rootDir: string,
): EnvFileProblem[] {
  if (resolution.failed !== undefined) {
    return [
      {
        file: resolution.marker ? workspaceFileOf(rootDir, resolution.marker) : "telo-workspace.yaml",
        reason: resolution.failed,
      },
    ];
  }
  return resolution.unreadable.map((file) => ({
    file: workspaceFileOf(rootDir, file.path),
    reason: file.reason,
  }));
}

/** The environment inputs of an Application whose values belong in a sensitive
 *  env file: its secrets bound by `env:`. Need fields have no row in Studio, so
 *  no need table is consulted. */
export function applicationSensitiveInputs(
  manifest: ParsedManifest | null,
): SensitiveEnvironmentInput[] {
  if (!manifest || manifest.kind !== "Application") return [];
  return sensitiveEnvironmentInputs({ kind: "Telo.Application", secrets: manifest.secrets }, []);
}
