import type { DirEntry, WorkspaceAdapter } from "../model";
import {
  SCAN_EXCLUDED_NAMES,
  SCAN_EXCLUDED_RELATIVE_PATHS,
  pathJoin,
} from "./paths";

/** A node in the raw workspace file tree. Mirrors the on-disk directory
 *  structure one-to-one — unlike `workspace.documents`, which holds only
 *  parsed telo files. Directories carry their `children`; files do not. */
export interface FileNode {
  name: string;
  /** Absolute, normalized path (the same key shape used everywhere else). */
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

/** Eagerly walks the whole workspace tree via the adapter's `listDir`, applying
 *  the same exclusions as the module scanner so the explorer never shows
 *  `node_modules`, `.git`, build output, etc. Returns the children of the root
 *  directory (the root itself is implicit). Driven entirely off the adapter so
 *  any future backend (remote dir, git repo) produces a tree unchanged. */
export async function buildFileTree(
  rootDir: string,
  adapter: WorkspaceAdapter,
): Promise<FileNode[]> {
  const rootPrefix = rootDir.endsWith("/") ? rootDir : rootDir + "/";

  function isExcluded(fullPath: string, name: string): boolean {
    if (SCAN_EXCLUDED_NAMES.has(name)) return true;
    const rel = fullPath.startsWith(rootPrefix) ? fullPath.slice(rootPrefix.length) : fullPath;
    return SCAN_EXCLUDED_RELATIVE_PATHS.includes(rel);
  }

  async function walk(dir: string): Promise<FileNode[]> {
    let entries: DirEntry[];
    try {
      entries = await adapter.listDir(dir);
    } catch {
      return [];
    }
    const nodes: FileNode[] = [];
    for (const entry of entries) {
      const fullPath = pathJoin(dir, entry.name);
      if (isExcluded(fullPath, entry.name)) continue;
      if (entry.isDirectory) {
        nodes.push({
          name: entry.name,
          path: fullPath,
          isDirectory: true,
          children: await walk(fullPath),
        });
      } else {
        nodes.push({ name: entry.name, path: fullPath, isDirectory: false });
      }
    }
    return sortNodes(nodes);
  }

  return walk(rootDir);
}

/** Directories first, then files; each group alphabetical (case-insensitive) —
 *  the conventional explorer ordering. */
function sortNodes(nodes: FileNode[]): FileNode[] {
  return nodes.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}
