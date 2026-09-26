import type { DirectoryEntry, DirectoryEntryKind } from "@telorun/editor-protocol";
import type { FileKind, HostFileSystem } from "@telorun/language-host";
import type { Dirent } from "fs";
import * as fs from "fs/promises";
import { fileURLToPath } from "url";

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** What an entry is, read without following it: a link is `symlink`. */
function kindOf(entry: Dirent): DirectoryEntryKind {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  return entry.isFile() ? "file" : "other";
}

/** The workspace on this machine's disk, as the raw file system the language
 *  host builds every `telo/*` answer on. `stat` follows links; a listing
 *  reports each entry's own kind. A path naming nothing is `undefined`; any
 *  other failure rejects with the operating system's reason. */
export class NodeAdapter implements HostFileSystem {
  async stat(uri: string): Promise<FileKind | undefined> {
    try {
      const stat = await fs.stat(fileURLToPath(uri));
      return stat.isDirectory() ? "directory" : "file";
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  readText(uri: string): Promise<string> {
    return fs.readFile(fileURLToPath(uri), "utf8");
  }

  async readDirectory(uri: string): Promise<DirectoryEntry[]> {
    const entries = await fs.readdir(fileURLToPath(uri), { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, kind: kindOf(e) }));
  }
}
