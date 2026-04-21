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
// LocalStorageAdapter — browser fallback (Firefox/Safari) for a virtual
// workspace. Paths rooted at `rootDir` are stored under a keyed prefix.
// ---------------------------------------------------------------------------

const LS_WORKSPACE_PREFIX = "telo-editor-workspace:";

export class LocalStorageAdapter implements ManifestAdapter, WorkspaceAdapter {
  constructor(private readonly rootDir: string) {}

  supports(url: string): boolean {
    return !url.startsWith("http") && !url.startsWith("pkg:");
  }

  private storageKey(path: string): string {
    return LS_WORKSPACE_PREFIX + path;
  }

  private allKeys(): string[] {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(LS_WORKSPACE_PREFIX)) keys.push(k);
    }
    return keys;
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    const text = window.localStorage.getItem(this.storageKey(url));
    if (text === null) throw new Error(`File not found: ${url}`);
    return { text, source: url };
  }

  async readFile(path: string): Promise<string> {
    return (await this.read(path)).text;
  }

  async writeFile(path: string, text: string): Promise<void> {
    window.localStorage.setItem(this.storageKey(path), text);
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const normalized = path.endsWith("/") ? path : path + "/";
    const seen = new Map<string, boolean>();
    for (const key of this.allKeys()) {
      const p = key.slice(LS_WORKSPACE_PREFIX.length);
      if (!p.startsWith(normalized)) continue;
      const rest = p.slice(normalized.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash === -1) seen.set(rest, false);
      else seen.set(rest.slice(0, slash), true);
    }
    return [...seen].map(([name, isDirectory]) => ({ name, isDirectory }));
  }

  async createDir(_path: string): Promise<void> {
    // Directories are implicit — nothing to do until a file is written under them.
  }

  async delete(path: string): Promise<void> {
    const prefix = this.storageKey(path);
    for (const key of this.allKeys()) {
      if (key === prefix || key.startsWith(prefix + "/")) {
        window.localStorage.removeItem(key);
      }
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

  get root(): string {
    return this.rootDir;
  }
}
