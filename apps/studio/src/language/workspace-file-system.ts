import type { DirectoryEntry } from "@telorun/editor-protocol";
import type { FileKind, HostFileSystem } from "@telorun/language-host";
import { DirectoryNotFoundError } from "../loader/adapters/directory-not-found";
import { normalizePath, pathBasename, pathDirname } from "../loader/paths";
import type { WorkspaceAdapter } from "../model";
import { fileUriToPath } from "./file-uri";

/**
 * The workspace, as the raw file system the language host answers the engine's
 * `telo/*` reads from — over the same adapter every other studio read and write
 * goes through (Tauri fs, File System Access, local storage), read per request
 * so a re-opened workspace is read through its new adapter.
 *
 * `confineTo` bounds a workspace whose paths are virtual: a browser workspace
 * holds nothing outside its root, so a path there names nothing rather than
 * being handed to an adapter that would read it relative to the root. The
 * desktop workspace is the real disk, unconfined, as it is for `telo check`.
 */
export class WorkspaceFileSystem implements HostFileSystem {
  private readonly root: string | undefined;

  constructor(
    private readonly adapter: () => WorkspaceAdapter,
    confineTo?: string,
  ) {
    this.root = confineTo === undefined ? undefined : normalizePath(confineTo);
  }

  async stat(uri: string): Promise<FileKind | undefined> {
    const path = fileUriToPath(uri);
    if (!this.within(path)) return undefined;
    const parent = pathDirname(path);
    if (parent === path || path === this.root) {
      return (await this.listing(path)) ? "directory" : undefined;
    }
    const entry = (await this.listing(parent))?.find((e) => e.name === pathBasename(path));
    if (!entry) return undefined;
    if (entry.kind !== "symlink") return entry.kind === "directory" ? "directory" : "file";
    // `stat` follows a link (the `HostFileSystem` contract): a link the adapter
    // can list through names a directory, any other a file — a dangling one
    // then fails at its read with the adapter's own reason.
    return (await this.listing(path)) ? "directory" : "file";
  }

  async readText(uri: string): Promise<string> {
    const path = fileUriToPath(uri);
    if (!this.within(path)) throw new Error(`'${path}' is outside the workspace ${this.root}.`);
    return this.adapter().readFile(path);
  }

  async readDirectory(uri: string): Promise<DirectoryEntry[]> {
    const path = fileUriToPath(uri);
    const entries = this.within(path) ? await this.listing(path) : undefined;
    if (!entries) throw new Error(`'${path}' is not a directory of the workspace.`);
    return entries.map((e) => ({ name: e.name, kind: e.kind }));
  }

  private within(path: string): boolean {
    const root = this.root;
    return root === undefined || root === "/" || path === root || path.startsWith(`${root}/`);
  }

  private async listing(path: string) {
    try {
      return await this.adapter().listDir(path);
    } catch (error) {
      if (error instanceof DirectoryNotFoundError) return undefined;
      throw error;
    }
  }
}
