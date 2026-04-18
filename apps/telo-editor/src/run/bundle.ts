import type { Workspace } from "../model";
import type { RunBundle } from "./types";

export async function buildRunBundle(
  workspace: Workspace,
  entryFilePath: string,
  readFile: (absPath: string) => Promise<string>,
): Promise<RunBundle> {
  const entry = workspace.modules.get(entryFilePath);
  if (!entry) {
    throw new Error(`Entry module not found in workspace: ${entryFilePath}`);
  }
  if (entry.kind !== "Application") {
    throw new Error(
      `Entry module must be an Application, but ${entry.metadata.name} (${entryFilePath}) is a ${entry.kind}`,
    );
  }

  const visitedModules = new Set<string>();
  const queue: string[] = [entryFilePath];
  const collectedPaths: string[] = [];

  while (queue.length > 0) {
    const currentPath = queue.shift()!;
    if (visitedModules.has(currentPath)) continue;
    visitedModules.add(currentPath);

    const mod = workspace.modules.get(currentPath);
    if (!mod) continue;

    collectedPaths.push(currentPath);

    if (mod.include) {
      const moduleDir = posixDirname(toPosix(currentPath));
      for (const includePath of mod.include) {
        collectedPaths.push(posixResolve(moduleDir, includePath));
      }
    }

    for (const imp of mod.imports) {
      if (imp.importKind !== "local") continue;
      if (!imp.resolvedPath) continue;
      if (visitedModules.has(imp.resolvedPath)) continue;
      queue.push(imp.resolvedPath);
    }
  }

  const uniquePaths = Array.from(new Set(collectedPaths.map(toPosix)));

  const contents = await Promise.all(uniquePaths.map((p) => readFile(p)));

  // Bundle root is the common ancestor directory of every file we're shipping.
  // This means the tempdir layout inside `/srv` mirrors the workspace's
  // relative layout: an Application at `/ws/app/telo.yaml` importing a
  // Library at `/ws/libs/b/telo.yaml` produces a bundle with root `/ws`, so
  // the entry ends up at `app/telo.yaml` and the library at `libs/b/telo.yaml`.
  //
  // One side-effect worth knowing: adding or removing siblings can shift the
  // root (e.g. removing the library collapses the root to `/ws/app`, making
  // the entry `telo.yaml`). That's fine for docker — the runner mounts root
  // at `/srv` and executes `./<entryRelativePath>` — but code that memoizes
  // bundle paths across runs shouldn't assume stability.
  const bundleRoot = commonAncestorDir(uniquePaths);
  const entryPosix = toPosix(entryFilePath);

  return {
    entryRelativePath: posixRelativeFromDir(bundleRoot, entryPosix),
    files: uniquePaths.map((absPath, i) => ({
      relativePath: posixRelativeFromDir(bundleRoot, absPath),
      contents: contents[i]!,
    })),
  };
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:\//.test(p);
}

function posixDirname(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx === -1) return "";
  if (idx === 0) return "/";
  return p.slice(0, idx);
}

function posixResolve(fromDir: string, rel: string): string {
  const relNorm = toPosix(rel);
  if (isAbsolute(relNorm)) return relNorm;

  const segs = fromDir.split("/");
  for (const s of relNorm.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (segs.length > 0 && segs[segs.length - 1] !== "") segs.pop();
      continue;
    }
    segs.push(s);
  }
  return segs.join("/");
}

function commonAncestorDir(filePaths: string[]): string {
  if (filePaths.length === 0) return "";
  if (filePaths.length === 1) return posixDirname(filePaths[0]!);

  const dirSegs = filePaths.map((p) => posixDirname(p).split("/"));
  const first = dirSegs[0]!;
  const prefix: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i]!;
    if (dirSegs.every((s) => s[i] === seg)) prefix.push(seg);
    else break;
  }

  const joined = prefix.join("/");
  return joined || (first[0] === "" ? "/" : "");
}

function posixRelativeFromDir(fromDir: string, absPath: string): string {
  if (fromDir === "") return absPath;
  if (fromDir === "/") return absPath.startsWith("/") ? absPath.slice(1) : absPath;
  const prefix = fromDir.endsWith("/") ? fromDir : fromDir + "/";
  if (absPath.startsWith(prefix)) return absPath.slice(prefix.length);
  if (absPath === fromDir) return "";
  return absPath;
}
