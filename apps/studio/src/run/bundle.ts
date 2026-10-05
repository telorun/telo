import type { Workspace } from "../model";
import type { RunBundle } from "./types";

export async function buildRunBundle(
  workspace: Workspace,
  entryFilePath: string,
  readFile: (absPath: string) => Promise<string>,
  selectFiles?: (base: string, patterns: string[]) => Promise<string[]>,
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
  // Modules declaring `files:` asset globs (e.g. an Http.Static `root:` dir).
  // Expanded after the walk so the recursive directory listing runs once per
  // owner rather than inline in the synchronous BFS.
  const fileGlobs: Array<{ source: string; patterns: string[] }> = [];

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

    if (mod.files?.length) {
      fileGlobs.push({ source: currentPath, patterns: mod.files });
    }

    for (const imp of mod.imports) {
      if (imp.importKind !== "local") continue;
      if (!imp.resolvedPath) continue;
      if (visitedModules.has(imp.resolvedPath)) continue;
      queue.push(imp.resolvedPath);
    }
  }

  if (fileGlobs.length > 0) {
    if (!selectFiles) {
      throw new Error(
        `Cannot bundle 'files:' assets without a file selector: ${fileGlobs
          .map((g) => g.source)
          .join(", ")}`,
      );
    }
    const selected = await Promise.all(fileGlobs.map((g) => selectFiles(g.source, g.patterns)));
    for (const group of selected) {
      for (const assetPath of group) collectedPaths.push(toPosix(assetPath));
    }
  }

  const uniquePaths = Array.from(new Set(collectedPaths.map(toPosix)));

  const contents = await Promise.all(uniquePaths.map((p) => readFile(p)));

  // **Bundle paths are relative to the WORKSPACE root**, so the session's
  // workspace holds each file where the editor holds it: an Application at
  // `<root>/apps/todo/telo.yaml` is `apps/todo/telo.yaml` there. The session
  // workspace has more than one writer — the agent's sync writes the editor's
  // whole tree into the same volume, relative to the same root — and two
  // layouts over one directory is one of them deleting the other's files: the
  // sync finds the app at a path the editor does not have, removes it, and the
  // running kernel loses its entry manifest.
  //
  // A file the closure reaches OUTSIDE the workspace root (an import climbing
  // above it) cannot be placed under that root, so such a bundle falls back to
  // the common ancestor of what it ships — the only root that holds all of it.
  const workspaceRoot = toPosix(workspace.rootDir).replace(/\/+$/, "");
  const underRoot = (p: string) => workspaceRoot !== "" && p.startsWith(`${workspaceRoot}/`);
  const bundleRoot = uniquePaths.every(underRoot) ? workspaceRoot : commonAncestorDir(uniquePaths);
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
