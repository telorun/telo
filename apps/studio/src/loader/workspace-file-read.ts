import type { EnvFileRead, ReadEnvFile } from "@telorun/analyzer";
import type { WorkspaceAdapter } from "../model";
import { DirectoryNotFoundError } from "./adapters/directory-not-found";
import { pathBasename, pathDirname } from "./paths";

/**
 * One read of a workspace file that says what it found — its text, nothing
 * there, a directory, or a file that exists and could not be read with the
 * adapter's reason — the read the analyzer's env-file walk and sensitivity
 * classifier take. An adapter answers a failed read with an error alone, so a
 * failure is told apart by listing the parent: a file that is listed and still
 * cannot be read is unreadable, never taken for an absent one.
 */
export function workspaceFileRead(adapter: WorkspaceAdapter): ReadEnvFile {
  return async (path: string): Promise<EnvFileRead> => {
    let failure: unknown;
    try {
      return { kind: "text", text: await adapter.readFile(path) };
    } catch (error) {
      failure = error;
    }
    let entries;
    try {
      entries = await adapter.listDir(pathDirname(path));
    } catch (error) {
      if (error instanceof DirectoryNotFoundError) return { kind: "missing" };
      return { kind: "unreadable", reason: messageOf(failure) };
    }
    const entry = entries.find((candidate) => candidate.name === pathBasename(path));
    if (!entry) return { kind: "missing" };
    if (entry.isDirectory) return { kind: "not-a-file" };
    return { kind: "unreadable", reason: messageOf(failure) };
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
