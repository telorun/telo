import type { ManifestSource } from "@telorun/analyzer";
import { DEFAULT_MANIFEST_FILENAME } from "@telorun/analyzer";
import { DirectoryNotFoundError } from "../loader/adapters/directory-not-found";
import { expandGlobViaList, pathExtname, pathResolve } from "../loader/paths";
import type { DirEntry, WorkspaceAdapter } from "../model";
import { listFilesRecursive, type ByteStore } from "./byte-store";
import { TREE_DIR } from "./working-copy";

/** Every Cloud working copy is rooted here in the editor, on both builds. */
export const CLOUD_ROOT_PREFIX = "/cloud/";

export function cloudWorkspaceRoot(projectId: string): string {
  return CLOUD_ROOT_PREFIX + projectId;
}

/** The project id a root names, or null for a root that is not a Cloud
 *  working copy. */
export function cloudProjectIdOf(rootDir: string | null | undefined): string | null {
  if (!rootDir?.startsWith(CLOUD_ROOT_PREFIX)) return null;
  const id = rootDir.slice(CLOUD_ROOT_PREFIX.length).replace(/\/+$/, "");
  return id && !id.includes("/") ? id : null;
}

/**
 * A working copy as the workspace storage backend the rest of Studio uses:
 * text in, text out, over the working tree. The explorer, autosave, undo, runs
 * and the agent read and write through it, and nothing they do reaches Cloud.
 */
export class WorkingCopyAdapter implements ManifestSource, WorkspaceAdapter {
  private readonly rootDir: string;

  constructor(
    projectId: string,
    private readonly store: ByteStore,
    /** Called after every write, so what changed can be shown without polling. */
    private readonly onChange: () => void,
  ) {
    this.rootDir = cloudWorkspaceRoot(projectId);
  }

  supports(url: string): boolean {
    return !url.startsWith("http") && !url.startsWith("pkg:");
  }

  /** The path in the store, or null for one outside this working copy. */
  private treePath(path: string): string | null {
    if (path === this.rootDir) return TREE_DIR;
    if (!path.startsWith(this.rootDir + "/")) return null;
    const relative = path.slice(this.rootDir.length + 1).replace(/\/+$/, "");
    return relative ? `${TREE_DIR}/${relative}` : TREE_DIR;
  }

  private required(path: string): string {
    const target = this.treePath(path);
    if (target === null) throw new Error(`${path} is outside this working copy.`);
    return target;
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    return { text: await this.readFile(url), source: url };
  }

  async readFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.store.read(this.required(path)));
  }

  async writeFile(path: string, text: string): Promise<void> {
    await this.store.write(this.required(path), new TextEncoder().encode(text));
    this.onChange();
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const target = this.treePath(path);
    if (target === null) throw new DirectoryNotFoundError(path);
    const entries = await this.store.list(target);
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory,
      kind: entry.isDirectory ? "directory" : "file",
    }));
  }

  async createDir(path: string): Promise<void> {
    await this.store.makeDirectory(this.required(path));
  }

  async delete(path: string): Promise<void> {
    const target = this.required(path);
    if (target === TREE_DIR) throw new Error("Refusing to delete the workspace root.");
    await this.store.remove(target);
    this.onChange();
  }

  /** Copies bytes, then removes the source, so a binary file moves intact. */
  async rename(from: string, to: string): Promise<void> {
    const source = this.required(from);
    const destination = this.required(to);
    if (source === TREE_DIR) throw new Error("Refusing to move the workspace root.");
    if (!(await this.store.exists(source))) throw new Error(`${from} does not exist.`);
    let files: string[];
    try {
      files = (await listFilesRecursive(this.store, source)).map((f) => `/${f}`);
    } catch (error) {
      if (!(error instanceof DirectoryNotFoundError)) throw error;
      // Not a directory: one file.
      files = [""];
    }
    if (files.length === 0) await this.store.makeDirectory(destination);
    for (const file of files) {
      await this.store.write(destination + file, await this.store.read(source + file));
    }
    await this.store.remove(source);
    this.onChange();
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

  async exists(base: string, relative: string): Promise<boolean> {
    const target = this.treePath(pathResolve(base, relative));
    return target !== null && this.store.exists(target);
  }
}
