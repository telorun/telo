import type { ManifestSource } from "@telorun/analyzer";
import { DEFAULT_MANIFEST_FILENAME } from "@telorun/analyzer";
import type { DirEntry, WorkspaceAdapter } from "../../model";
import { expandGlobViaList, pathDirname, pathExtname, pathResolve } from "../paths";
import { DirectoryNotFoundError } from "./directory-not-found";

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
    try {
      return await readTextFile(path);
    } catch (error) {
      throw scopeRefusalExplained(path, error);
    }
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    return readFile(path);
  }

  async writeFile(path: string, text: string): Promise<void> {
    const { writeTextFile, mkdir, exists } = await import("@tauri-apps/plugin-fs");
    const dir = pathDirname(path);
    if (dir && !(await exists(dir))) {
      await mkdir(dir, { recursive: true });
    }
    try {
      await writeTextFile(path, text);
    } catch (error) {
      throw scopeRefusalExplained(path, error);
    }
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const { readDir, exists, stat } = await import("@tauri-apps/plugin-fs");
    if (!(await exists(path)) || !(await stat(path)).isDirectory) {
      throw new DirectoryNotFoundError(path);
    }
    const entries = await readDir(path);
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory,
      kind: e.isSymlink ? "symlink" : e.isDirectory ? "directory" : e.isFile ? "file" : "other",
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

  async rename(from: string, to: string): Promise<void> {
    const { rename, mkdir, exists } = await import("@tauri-apps/plugin-fs");
    const dir = pathDirname(to);
    if (dir && !(await exists(dir))) {
      await mkdir(dir, { recursive: true });
    }
    await rename(from, to);
  }

  resolveRelative(base: string, relative: string): string {
    const resolved = pathResolve(base, relative);
    if (!pathExtname(resolved)) return resolved + "/" + DEFAULT_MANIFEST_FILENAME;
    return resolved;
  }

  async expandGlob(base: string, patterns: string[]): Promise<string[]> {
    // `include:` resolution opts out of the default-ignore deny set.
    return expandGlobViaList(base, patterns, (dir) => this.listDir(dir), {
      applyDefaultIgnore: false,
    });
  }

  async entryAt(base: string, relative: string): Promise<"file" | "directory" | undefined> {
    const { exists, stat } = await import("@tauri-apps/plugin-fs");
    const target = pathResolve(base, relative);
    if (!(await exists(target))) return undefined;
    return (await stat(target)).isDirectory ? "directory" : "file";
  }
}

/** The shell's file scope refuses a path as `forbidden path: …`; said instead
 *  in terms of what the scope (`capabilities/default.json`) allows. */
function scopeRefusalExplained(path: string, error: unknown): unknown {
  const said = error instanceof Error ? error.message : String(error);
  if (!said.startsWith("forbidden path")) return error;
  return new Error(
    `${path} is outside Studio's desktop file scope, which reaches files under your home ` +
      `directory and, of its dot-files, only those named .env or .env.*.`,
  );
}
