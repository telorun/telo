import { DirectoryNotFoundError } from "../../loader/adapters/directory-not-found";
import type { DirEntry, WorkspaceAdapter } from "../../model";

/** A workspace held in a map of absolute paths to text, for tests. A path in
 *  `unreadable` is listed but its read fails, as a file without read
 *  permission does on disk. */
export function fileMapAdapter(
  initial: Record<string, string>,
  unreadable: ReadonlySet<string> = new Set(),
): WorkspaceAdapter & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  const isDirectory = (path: string) => [...files.keys()].some((file) => file.startsWith(`${path}/`));
  return {
    files,
    async readFile(path) {
      if (unreadable.has(path)) throw new Error(`EACCES: permission denied, open '${path}'`);
      const text = files.get(path);
      if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
      return text;
    },
    async readBytes(path) {
      return new TextEncoder().encode(await this.readFile(path));
    },
    async writeFile(path, text) {
      files.set(path, text);
    },
    async listDir(path) {
      if (!isDirectory(path)) throw new DirectoryNotFoundError(path);
      const entries = new Map<string, boolean>();
      for (const file of files.keys()) {
        if (!file.startsWith(`${path}/`)) continue;
        const rest = file.slice(path.length + 1);
        const slash = rest.indexOf("/");
        entries.set(slash === -1 ? rest : rest.slice(0, slash), slash !== -1);
      }
      return [...entries].map(
        ([name, directory]): DirEntry => ({ name, isDirectory: directory, kind: directory ? "directory" : "file" }),
      );
    },
    async createDir() {},
    async delete(path) {
      for (const file of [...files.keys()]) {
        if (file === path || file.startsWith(`${path}/`)) files.delete(file);
      }
    },
    async rename(from, to) {
      const text = files.get(from);
      if (text === undefined) throw new Error(`ENOENT: ${from}`);
      files.delete(from);
      files.set(to, text);
    },
  };
}
