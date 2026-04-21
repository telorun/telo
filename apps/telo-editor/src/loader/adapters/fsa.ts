import type { ManifestAdapter } from "@telorun/analyzer";
import { DEFAULT_MANIFEST_FILENAME } from "@telorun/analyzer";
import type { DirEntry, WorkspaceAdapter } from "../../model";
import {
  expandGlobViaList,
  listAllFilesRecursive,
  pathExtname,
  pathResolve,
} from "../paths";

// ---------------------------------------------------------------------------
// FsaAdapter — File System Access API (Chrome/Edge). Read + write.
// ---------------------------------------------------------------------------

export class FsaAdapter implements ManifestAdapter, WorkspaceAdapter {
  // rootAbs is the absolute path prefix under which `root` is mounted. All
  // incoming paths start with this prefix; we strip it to walk the FSA tree.
  // Stored without trailing slash so prefix arithmetic is consistent regardless
  // of how the caller constructed the rootDir string.
  private readonly rootAbs: string;

  constructor(
    private readonly root: FileSystemDirectoryHandle,
    rootAbs: string,
  ) {
    this.rootAbs = rootAbs.replace(/\/+$/, "");
  }

  supports(url: string): boolean {
    return !url.startsWith("http") && !url.startsWith("pkg:");
  }

  private toRelParts(path: string): string[] {
    let rel = path;
    if (rel.startsWith(this.rootAbs)) rel = rel.slice(this.rootAbs.length);
    if (rel.startsWith("/")) rel = rel.slice(1);
    return rel.split("/").filter(Boolean);
  }

  private async resolveDir(
    parts: string[],
    opts?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandle> {
    let dir: FileSystemDirectoryHandle = this.root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: opts?.create });
    }
    return dir;
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    const parts = this.toRelParts(url);
    const dir = await this.resolveDir(parts.slice(0, -1));
    const fileHandle = await dir.getFileHandle(parts[parts.length - 1]);
    const file = await fileHandle.getFile();
    return { text: await file.text(), source: url };
  }

  async readFile(path: string): Promise<string> {
    return (await this.read(path)).text;
  }

  async writeFile(path: string, text: string): Promise<void> {
    const parts = this.toRelParts(path);
    const dir = await this.resolveDir(parts.slice(0, -1), { create: true });
    const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const parts = this.toRelParts(path);
    const dir = await this.resolveDir(parts);
    const result: DirEntry[] = [];
    for await (const [name, handle] of dir.entries()) {
      result.push({ name: name as string, isDirectory: handle.kind === "directory" });
    }
    return result;
  }

  async createDir(path: string): Promise<void> {
    const parts = this.toRelParts(path);
    await this.resolveDir(parts, { create: true });
  }

  async delete(path: string): Promise<void> {
    const parts = this.toRelParts(path);
    if (parts.length === 0) throw new Error(`Refusing to delete workspace root`);
    const parent = await this.resolveDir(parts.slice(0, -1));
    await parent.removeEntry(parts[parts.length - 1], { recursive: true });
  }

  resolveRelative(base: string, relative: string): string {
    const resolved = pathResolve(base, relative);
    if (!pathExtname(resolved)) return resolved + "/" + DEFAULT_MANIFEST_FILENAME;
    return resolved;
  }

  async expandGlob(base: string, patterns: string[]): Promise<string[]> {
    return expandGlobViaList(base, patterns, (dir) => listAllFilesRecursive(dir, this));
  }
}
