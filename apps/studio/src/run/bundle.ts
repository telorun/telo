import { collectModuleFileClaims, type ModuleFileClaim } from "@telorun/analyzer";
import { encodeFileContent } from "../file-content-encoding";
import { DirectoryNotFoundError } from "../loader/adapters/directory-not-found";
import type { DirEntry, Workspace } from "../model";
import { selectModuleFiles } from "./select-module-files";
import type { RunBundle, RunBundleFile } from "./types";

/** The two reads a bundle needs of the workspace's storage. */
export interface RunBundleSource {
  readBytes(absPath: string): Promise<Uint8Array>;
  listDir(dir: string): Promise<DirEntry[]>;
}

/**
 * The files a run of `entryFilePath` reads: every local module it reaches, their
 * `include:` partials, their `files:` assets, and every file a tag in them claims
 * (`!module-path`, `!include-text`, `!include-bytes`) — the set `telo publish`
 * ships. A file whose bytes are not UTF-8 travels as base64.
 */
export async function buildRunBundle(
  workspace: Workspace,
  entryFilePath: string,
  source: RunBundleSource,
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
  // Each reached module's owner and its manifest files (owner + partials).
  const modules: Array<{ owner: string; manifests: string[]; files?: string[] }> = [];

  while (queue.length > 0) {
    const currentPath = queue.shift()!;
    if (visitedModules.has(currentPath)) continue;
    visitedModules.add(currentPath);

    const mod = workspace.modules.get(currentPath);
    if (!mod) continue;

    const owner = toPosix(currentPath);
    const moduleDir = posixDirname(owner);
    modules.push({
      owner,
      manifests: [owner, ...(mod.include ?? []).map((p) => posixResolve(moduleDir, p))],
      files: mod.files,
    });

    for (const imp of mod.imports) {
      if (imp.importKind !== "local") continue;
      if (!imp.resolvedPath) continue;
      if (visitedModules.has(imp.resolvedPath)) continue;
      queue.push(imp.resolvedPath);
    }
  }

  const listDir = (dir: string) => source.listDir(dir);
  const bytes = new Map<string, Promise<Uint8Array>>();
  const read = (p: string) => {
    let pending = bytes.get(p);
    if (!pending) {
      pending = source.readBytes(p);
      bytes.set(p, pending);
    }
    return pending;
  };

  const claimsOf = async (owner: string, manifest: string) => {
    const text = new TextDecoder().decode(await read(manifest));
    const claimed = await Promise.all(collectModuleFileClaims(text).map((claim) => claimedFiles(owner, claim, listDir)));
    return claimed.flat();
  };
  const perModule = await Promise.all(
    modules.map(async ({ owner, manifests, files }) => {
      const [assets, claimed] = await Promise.all([
        files?.length ? selectModuleFiles(owner, files, listDir) : Promise.resolve([]),
        Promise.all(manifests.map((manifest) => claimsOf(owner, manifest))),
      ]);
      return [...manifests, ...assets, ...claimed.flat()];
    }),
  );

  const uniquePaths = Array.from(new Set(perModule.flat().map(toPosix)));

  const contents = await Promise.all(uniquePaths.map((p) => read(p)));

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
    files: uniquePaths.map((absPath, i): RunBundleFile => {
      const { content, encoding } = encodeFileContent(contents[i]!);
      return {
        relativePath: posixRelativeFromDir(bundleRoot, absPath),
        contents: content,
        ...(encoding === "base64" ? { encoding } : {}),
      };
    }),
  };
}

/**
 * The files one asset claim names, resolved against the module root: the file
 * itself, or every file beneath a directory a `!module-path` names — as
 * `telo publish` expands them. A claim naming nothing it can ship contributes
 * nothing: the kernel's own refusal (`MODULE_PATH_NOT_FOUND`,
 * `INCLUDE_FILE_NOT_FOUND`) names it at load.
 */
async function claimedFiles(
  owner: string,
  claim: ModuleFileClaim,
  listDir: (dir: string) => Promise<DirEntry[]>,
): Promise<string[]> {
  if (claim.role !== "assets") return [];
  const target = posixResolve(posixDirname(owner), claim.path);
  const entry = await entryAt(target, listDir);
  if (!entry) return [];
  if (!entry.isDirectory) return [target];
  if (!claim.directory) return [];
  return (await selectModuleFiles(owner, [`${claim.path}/**`], listDir)).map(toPosix);
}

async function entryAt(
  path: string,
  listDir: (dir: string) => Promise<DirEntry[]>,
): Promise<DirEntry | null> {
  const name = path.slice(path.lastIndexOf("/") + 1);
  let entries: DirEntry[];
  try {
    entries = await listDir(posixDirname(path));
  } catch (error) {
    if (error instanceof DirectoryNotFoundError) return null;
    throw error;
  }
  return entries.find((e) => e.name === name) ?? null;
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
