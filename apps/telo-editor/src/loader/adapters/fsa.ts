import type { ManifestSource } from "@telorun/analyzer";
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

export class FsaAdapter implements ManifestSource, WorkspaceAdapter {
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

  // FSA has no native move, so copy the subtree (binary-safe via Blob) then
  // delete the source.
  async rename(from: string, to: string): Promise<void> {
    const fromParts = this.toRelParts(from);
    const toParts = this.toRelParts(to);
    if (fromParts.length === 0) throw new Error(`Refusing to move workspace root`);
    const parent = await this.resolveDir(fromParts.slice(0, -1));
    const name = fromParts[fromParts.length - 1];
    let isDir = false;
    try {
      await parent.getDirectoryHandle(name);
      isDir = true;
    } catch {
      isDir = false;
    }
    await this.copyEntry(fromParts, toParts, isDir);
    await this.delete(from);
  }

  private async copyEntry(fromParts: string[], toParts: string[], isDir: boolean): Promise<void> {
    if (!isDir) {
      const srcDir = await this.resolveDir(fromParts.slice(0, -1));
      const srcHandle = await srcDir.getFileHandle(fromParts[fromParts.length - 1]);
      const blob = await srcHandle.getFile();
      const destDir = await this.resolveDir(toParts.slice(0, -1), { create: true });
      const destHandle = await destDir.getFileHandle(toParts[toParts.length - 1], { create: true });
      const writable = await destHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    }
    const srcDir = await this.resolveDir(fromParts);
    await this.resolveDir(toParts, { create: true });
    for await (const [name, handle] of srcDir.entries()) {
      await this.copyEntry([...fromParts, name], [...toParts, name], handle.kind === "directory");
    }
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
