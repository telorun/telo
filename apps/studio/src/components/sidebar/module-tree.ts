import { isWorkspaceModule } from "../../loader";
import type { ParsedManifest, Workspace } from "../../model";

export interface ModuleNode {
  manifest: ParsedManifest;
  /** The module's directory, relative to the workspace root ("" at the root). */
  relativeDir: string;
  /** Modules whose directory lies inside this one's, nearest first. */
  children: ModuleNode[];
}

export interface ModuleForest {
  applications: ModuleNode[];
  libraries: ModuleNode[];
}

function parentDir(dir: string): string | null {
  if (dir === "") return null;
  const i = dir.lastIndexOf("/");
  return i === -1 ? "" : dir.slice(0, i);
}

/** The workspace's modules as a forest: a module whose directory lies inside
 *  another's is that module's child, at any depth. Roots are split by kind. */
export function buildModuleForest(workspace: Workspace): ModuleForest {
  const root = workspace.rootDir.endsWith("/") ? workspace.rootDir : workspace.rootDir + "/";
  const byDir = new Map<string, ModuleNode>();
  for (const [filePath, manifest] of workspace.modules) {
    if (!isWorkspaceModule(workspace, filePath)) continue;
    const rel = filePath.slice(root.length);
    const relativeDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    byDir.set(relativeDir, { manifest, relativeDir, children: [] });
  }

  const roots: ModuleNode[] = [];
  for (const node of byDir.values()) {
    let parent = parentDir(node.relativeDir);
    while (parent !== null && !byDir.has(parent)) parent = parentDir(parent);
    if (parent === null) roots.push(node);
    else byDir.get(parent)!.children.push(node);
  }

  const byRel = (a: ModuleNode, b: ModuleNode) => a.relativeDir.localeCompare(b.relativeDir);
  const sortTree = (nodes: ModuleNode[]) => {
    nodes.sort(byRel);
    for (const node of nodes) sortTree(node.children);
  };
  sortTree(roots);

  return {
    applications: roots.filter((n) => n.manifest.kind === "Application"),
    libraries: roots.filter((n) => n.manifest.kind !== "Application"),
  };
}

/** Every module in the given forest nodes and beneath them. */
export function flattenModules(nodes: ModuleNode[]): ModuleNode[] {
  return nodes.flatMap((node) => [node, ...flattenModules(node.children)]);
}
