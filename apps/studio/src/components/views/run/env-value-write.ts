import {
  appendEnvFileValue,
  clearEnvFileValue,
  envFileDestination,
  setEnvFileValue,
  type WorkspaceEnvResolution,
} from "@telorun/analyzer";
import { workspaceFileRead } from "../../../loader/workspace-file-read";
import type { WorkspaceAdapter } from "../../../model";
import { envFileBeside } from "../../../run/application-env";

/** Where an unset value would be written, or why it cannot be: the manifest's
 *  own directory, in the last `env.files` entry of the kind the value needs. */
export function envValueDestination(
  resolution: WorkspaceEnvResolution,
  manifestPath: string,
  sensitive: boolean,
): { path: string } | { refused: string } {
  const destination = envFileDestination(resolution.entries, sensitive);
  if ("refused" in destination) return destination;
  return { path: envFileBeside(manifestPath, destination.name) };
}

/**
 * Writes one value of an Application's environment into the workspace's env
 * files, through the analyzer's edits so every other byte of the file stays as
 * it was:
 *
 * - a value that comes from a file is rewritten on its line in that file, and
 *   an empty one removes the key's lines there;
 * - an unset value is appended to the file `envValueDestination` names.
 *
 * Rejects with the reason when the edit is refused or a file cannot be read.
 */
export async function writeEnvValue(options: {
  adapter: WorkspaceAdapter;
  resolution: WorkspaceEnvResolution;
  manifestPath: string;
  key: string;
  value: string;
  sensitive: boolean;
}): Promise<void> {
  const { adapter, resolution, manifestPath, key, value, sensitive } = options;
  const source = resolution.sources[key];
  if (source !== undefined) {
    const text = await adapter.readFile(source);
    const edit = value === "" ? clearEnvFileValue(text, key) : setEnvFileValue(text, key, value);
    if (!edit.ok) throw new Error(edit.reason);
    await adapter.writeFile(source, edit.text);
    return;
  }
  if (value === "") return;

  const destination = envValueDestination(resolution, manifestPath, sensitive);
  if ("refused" in destination) throw new Error(destination.refused);
  const found = await workspaceFileRead(adapter)(destination.path);
  if (found.kind === "not-a-file") throw new Error(`${destination.path} is not a file.`);
  if (found.kind === "unreadable") {
    throw new Error(`${destination.path} could not be read: ${found.reason}`);
  }
  const edit = appendEnvFileValue(found.kind === "text" ? found.text : "", key, value);
  if (!edit.ok) throw new Error(edit.reason);
  await adapter.writeFile(destination.path, edit.text);
}
