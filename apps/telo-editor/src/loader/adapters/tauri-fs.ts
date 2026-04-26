import type { ManifestSource } from "@telorun/analyzer";
import { DEFAULT_MANIFEST_FILENAME } from "@telorun/analyzer";
import type { DirEntry, WorkspaceAdapter } from "../../model";
import {
  expandGlobViaList,
  listAllFilesRecursive,
  pathDirname,
  pathExtname,
  pathResolve,
} from "../paths";

// ---------------------------------------------------------------------------
// TauriFsAdapter — implements both ManifestSource and WorkspaceAdapter via
// @tauri-apps/plugin-fs. Single code path for all filesystem operations.
// ---------------------------------------------------------------------------

export class TauriFsAdapter implements ManifestSource, WorkspaceAdapter {
  supports(url: string): boolean {
    return !url.startsWith("http") && !url.startsWith("pkg:");
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const text = await readTextFile(url);
    return { text, source: url };
  }

  async readFile(path: string): Promise<string> {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return readTextFile(path);
  }

  async writeFile(path: string, text: string): Promise<void> {
    const { writeTextFile, mkdir, exists } = await import("@tauri-apps/plugin-fs");
    const dir = pathDirname(path);
    if (dir && !(await exists(dir))) {
      await mkdir(dir, { recursive: true });
    }
    await writeTextFile(path, text);
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const { readDir } = await import("@tauri-apps/plugin-fs");
    const entries = await readDir(path);
    return entries.map((e: { name: string; isDirectory: boolean }) => ({
      name: e.name,
      isDirectory: e.isDirectory,
    }));
  }

  async createDir(path: string): Promise<void> {
    const { mkdir } = await import("@tauri-apps/plugin-fs");
    await mkdir(path, { recursive: true });
  }

  async delete(path: string): Promise<void> {
    const { remove } = await import("@tauri-apps/plugin-fs");
    await remove(path, { recursive: true });
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
