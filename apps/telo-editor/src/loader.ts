import type { ManifestAdapter } from "@telorun/analyzer";
import { DEFAULT_MANIFEST_FILENAME, Loader, RegistryAdapter, isModuleKind } from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import type {
  AppSettings,
  AvailableKind,
  DirEntry,
  ImportKind,
  ModuleKind,
  ParsedImport,
  ParsedManifest,
  ParsedResource,
  RegistryServer,
  Workspace,
  WorkspaceAdapter,
} from "./model";

// Directory basenames skipped at any depth during workspace scan.
export const SCAN_EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  ".git",
  "__fixtures__",
]);

// Path suffixes (relative to workspace root) skipped during scan. Used for
// compound paths that would be too broad as a bare basename — e.g. matching
// "build" alone would also skip unrelated build output in other subtrees.
export const SCAN_EXCLUDED_RELATIVE_PATHS: readonly string[] = [
  "pages/build", // Docusaurus output
];

type LoaderOptionsCompat = {
  extraAdapters?: ManifestAdapter[];
  includeHttpAdapter?: boolean;
  includeRegistryAdapter?: boolean;
  registryUrl?: string;
};

const LoaderCtor = Loader as unknown as new (
  extraAdaptersOrOptions?: ManifestAdapter[] | LoaderOptionsCompat,
) => Loader;

export function isRegistryImportSource(source: string): boolean {
  return (
    !source.startsWith("http://") &&
    !source.startsWith("https://") &&
    !source.startsWith("/") &&
    !source.startsWith(".") &&
    source.includes("@") &&
    source.includes("/")
  );
}

export function parseRegistryRef(source: string): { moduleId: string; version: string } | null {
  if (!isRegistryImportSource(source)) return null;
  const atIdx = source.lastIndexOf("@");
  if (atIdx <= 0 || atIdx === source.length - 1) return null;
  const moduleId = source.slice(0, atIdx);
  if (!moduleId.includes("/")) return null;
  const rawVersion = source.slice(atIdx + 1);
  const version = rawVersion.startsWith("v") ? rawVersion.substring(1) : rawVersion;
  return { moduleId, version };
}

export interface RegistryVersion {
  version: string;
  publishedAt: string;
}

export async function fetchAvailableVersions(
  moduleId: string,
  registryServers: RegistryServer[],
): Promise<RegistryVersion[]> {
  const enabled = registryServers.filter((s) => s.enabled);
  if (!enabled.length) return [];

  const results = await Promise.allSettled(
    enabled.map((server) =>
      fetch(`${server.url.replace(/\/$/, "")}/${moduleId}/versions`)
        .then((r) =>
          r.ok ? (r.json() as Promise<{ items: RegistryVersion[] }>) : { items: [] },
        )
        .then((data) => data.items ?? []),
    ),
  );

  const seen = new Set<string>();
  const merged: RegistryVersion[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      for (const item of r.value) {
        if (!seen.has(item.version)) {
          seen.add(item.version);
          merged.push(item);
        }
      }
    }
  }
  return merged;
}

const registryFallbackBlocker: ManifestAdapter = {
  supports(url: string): boolean {
    return isRegistryImportSource(url);
  },
  async read(url: string): Promise<{ text: string; source: string }> {
    throw new Error(
      `No enabled registry server can resolve '${url}'. Configure at least one registry in settings.`,
    );
  },
  resolveRelative(_base: string, relative: string): string {
    return relative;
  },
};

function createEditorLoader(localAdapter: ManifestAdapter, registryAdapters: ManifestAdapter[]): Loader {
  try {
    return new LoaderCtor({
      extraAdapters: [...registryAdapters, localAdapter],
      includeRegistryAdapter: false,
    });
  } catch {
    const legacyAdapters = registryAdapters.length
      ? [...registryAdapters, localAdapter]
      : [registryFallbackBlocker, localAdapter];
    return new LoaderCtor(legacyAdapters);
  }
}

// ---------------------------------------------------------------------------
// Path utilities (avoids a browser polyfill dependency)
// ---------------------------------------------------------------------------

function pathDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "." : i === 0 ? "/" : p.slice(0, i);
}

function pathBasename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function pathExtname(p: string): string {
  const base = pathBasename(p);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i);
}

function pathJoin(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join("/"));
}

function pathResolve(base: string, rel: string): string {
  if (rel.startsWith("/")) return normalizePath(rel);
  const combined = pathDirname(base) + "/" + rel;
  return normalizePath(combined);
}

function pathRelative(from: string, to: string): string {
  const fromParts = from.split("/").filter(Boolean);
  const toParts = to.split("/").filter(Boolean);
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
  const ups = fromParts.length - i;
  const rel = [...Array(ups).fill(".."), ...toParts.slice(i)].join("/");
  return rel || ".";
}

function normalizePath(p: string): string {
  const abs = p.startsWith("/");
  const parts = p.split("/");
  const stack: string[] = [];
  for (const seg of parts) {
    if (seg === "..") stack.pop();
    else if (seg !== "" && seg !== ".") stack.push(seg);
  }
  return (abs ? "/" : "") + stack.join("/");
}

// ---------------------------------------------------------------------------
// Public path/string utilities
// ---------------------------------------------------------------------------

export function toPascalCase(s: string): string {
  return s
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

export function toRelativeSource(fromPath: string, toPath: string): string {
  const fromDir = pathDirname(fromPath);
  const toDir = pathDirname(toPath);
  const rel = pathRelative(fromDir, toDir);
  return rel === "." ? "." : rel.startsWith(".") ? rel : "./" + rel;
}

export async function readModuleMetadata(
  filePath: string,
  adapter: ManifestAdapter,
): Promise<string | null> {
  try {
    const loader = createEditorLoader(adapter, []);
    const docs = (await loader.loadModule(filePath)) as ResourceManifest[];
    const moduleDoc = docs.find((d) => isModuleKind(d.kind));
    return (moduleDoc?.metadata.name as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Loads the sub-graph reachable from `entryPath` into the mutable maps and
 *  returns the actual root URL the entry resolved to (which may differ from
 *  the input — e.g. registry adapters expand to a full URL). All resources
 *  and graph edges in the sub-graph are added; nothing that already exists
 *  in the maps is overwritten. */
async function mergeSubGraph(
  entryPath: string,
  modules: Map<string, ParsedManifest>,
  importGraph: Map<string, Set<string>>,
  importedBy: Map<string, Set<string>>,
  adapter: ManifestAdapter,
  extraAdapters: ManifestAdapter[],
): Promise<string> {
  const loader = createEditorLoader(adapter, extraAdapters);
  const subGraph = await loader.loadModuleGraph(entryPath, (url, err) => {
    console.error(`Failed to load module ${url}:`, err);
  });

  // Registry/remote adapters may resolve `entryPath` to a differently-keyed URL.
  let actualRoot = entryPath;
  if (!subGraph.has(entryPath) && subGraph.size > 0) {
    actualRoot = subGraph.keys().next().value as string;
  }

  for (const [filePath, docs] of subGraph) {
    if (modules.has(filePath)) continue;
    const parsed = buildParsedManifest(filePath, docs);
    const subDeps = new Set<string>();
    const resolvedImports = parsed.imports.map((imp) => {
      const depPath = resolveDepPath(adapter, filePath, imp.source);
      if (subGraph.has(depPath)) {
        subDeps.add(depPath);
        if (!importedBy.has(depPath)) importedBy.set(depPath, new Set());
        importedBy.get(depPath)!.add(filePath);
      }
      return { ...imp, resolvedPath: depPath };
    });
    modules.set(filePath, { ...parsed, imports: resolvedImports });
    importGraph.set(filePath, subDeps);
  }

  return actualRoot;
}

// Appends an import to the active module and loads the target module graph
// if the target isn't already known (registry/remote imports).
export async function addImport(
  workspace: Workspace,
  fromPath: string,
  imp: ParsedImport,
  adapter: ManifestAdapter,
  extraAdapters: ManifestAdapter[] = [],
): Promise<Workspace> {
  const modules = new Map(workspace.modules);
  const importGraph = new Map(workspace.importGraph);
  const importedBy = new Map(workspace.importedBy);

  const fromModule = modules.get(fromPath);
  if (!fromModule) return workspace;

  let resolvedPath = imp.resolvedPath ?? resolveDepPath(adapter, fromPath, imp.source);

  if (!modules.has(resolvedPath)) {
    const actualRoot = await mergeSubGraph(
      resolvedPath,
      modules,
      importGraph,
      importedBy,
      adapter,
      extraAdapters,
    );
    resolvedPath = actualRoot;
  }

  const resolvedImp: ParsedImport = { ...imp, resolvedPath };
  modules.set(fromPath, { ...fromModule, imports: [...fromModule.imports, resolvedImp] });

  const deps = new Set(importGraph.get(fromPath) ?? []);
  deps.add(resolvedPath);
  importGraph.set(fromPath, deps);

  if (!importedBy.has(resolvedPath)) importedBy.set(resolvedPath, new Set());
  importedBy.get(resolvedPath)!.add(fromPath);

  return { rootDir: workspace.rootDir, modules, importGraph, importedBy };
}

// ---------------------------------------------------------------------------
// TauriFsAdapter — implements both ManifestAdapter and WorkspaceAdapter via
// @tauri-apps/plugin-fs. Single code path for all filesystem operations.
// ---------------------------------------------------------------------------

class TauriFsAdapter implements ManifestAdapter, WorkspaceAdapter {
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
}

// ---------------------------------------------------------------------------
// FsaAdapter — File System Access API (Chrome/Edge). Read + write.
// ---------------------------------------------------------------------------

class FsaAdapter implements ManifestAdapter, WorkspaceAdapter {
  // rootAbs is the absolute path prefix under which `root` is mounted. All
  // incoming paths start with this prefix; we strip it to walk the FSA tree.
  // Stored without trailing slash so prefix arithmetic is consistent regardless
  // of how the caller constructed the rootDir string.
  private readonly rootAbs: string;

  constructor(
    private readonly root: FileSystemDirectoryHandle,
    rootAbs: string,
  ) {
    this.rootAbs = rootAbs.replace(/\/+$/, "");
  }

  supports(url: string): boolean {
    return !url.startsWith("http") && !url.startsWith("pkg:");
  }

  private toRelParts(path: string): string[] {
    let rel = path;
    if (rel.startsWith(this.rootAbs)) rel = rel.slice(this.rootAbs.length);
    if (rel.startsWith("/")) rel = rel.slice(1);
    return rel.split("/").filter(Boolean);
  }

  private async resolveDir(
    parts: string[],
    opts?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandle> {
    let dir: FileSystemDirectoryHandle = this.root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: opts?.create });
    }
    return dir;
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    const parts = this.toRelParts(url);
    const dir = await this.resolveDir(parts.slice(0, -1));
    const fileHandle = await dir.getFileHandle(parts[parts.length - 1]);
    const file = await fileHandle.getFile();
    return { text: await file.text(), source: url };
  }

  async readFile(path: string): Promise<string> {
    return (await this.read(path)).text;
  }

  async writeFile(path: string, text: string): Promise<void> {
    const parts = this.toRelParts(path);
    const dir = await this.resolveDir(parts.slice(0, -1), { create: true });
    const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const parts = this.toRelParts(path);
    const dir = await this.resolveDir(parts);
    const result: DirEntry[] = [];
    for await (const [name, handle] of dir.entries()) {
      result.push({ name: name as string, isDirectory: handle.kind === "directory" });
    }
    return result;
  }

  async createDir(path: string): Promise<void> {
    const parts = this.toRelParts(path);
    await this.resolveDir(parts, { create: true });
  }

  async delete(path: string): Promise<void> {
    const parts = this.toRelParts(path);
    if (parts.length === 0) throw new Error(`Refusing to delete workspace root`);
    const parent = await this.resolveDir(parts.slice(0, -1));
    await parent.removeEntry(parts[parts.length - 1], { recursive: true });
  }

  resolveRelative(base: string, relative: string): string {
    const resolved = pathResolve(base, relative);
    if (!pathExtname(resolved)) return resolved + "/" + DEFAULT_MANIFEST_FILENAME;
    return resolved;
  }
}

// ---------------------------------------------------------------------------
// LocalStorageAdapter — browser fallback (Firefox/Safari) for a virtual
// workspace. Paths rooted at `rootDir` are stored under a keyed prefix.
// ---------------------------------------------------------------------------

const LS_WORKSPACE_PREFIX = "telo-editor-workspace:";

class LocalStorageAdapter implements ManifestAdapter, WorkspaceAdapter {
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

  get root(): string {
    return this.rootDir;
  }
}

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

export function isInTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function supportsDirectoryPicker(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

// A no-op local adapter — supports nothing, used when only registry adapters are needed.
export const noopAdapter: ManifestAdapter = {
  supports: () => false,
  read: (url) => Promise.reject(new Error(`No adapter for: ${url}`)),
  resolveRelative: (_base, relative) => relative,
};

// ---------------------------------------------------------------------------
// Workspace open
// ---------------------------------------------------------------------------

export interface OpenedWorkspace {
  manifestAdapter: ManifestAdapter;
  workspaceAdapter: WorkspaceAdapter;
  rootDir: string;
}

/** Constructs adapters for a known rootDir without showing a picker. Used to
 *  auto-restore a workspace on mount. Returns null when the current environment
 *  cannot re-attach to the path silently (e.g. FSA, where the directory handle
 *  isn't persisted across reloads). */
export function reopenWorkspaceAt(rootDir: string): OpenedWorkspace | null {
  if (isInTauri()) {
    const adapter = new TauriFsAdapter();
    return { manifestAdapter: adapter, workspaceAdapter: adapter, rootDir };
  }
  if (!supportsDirectoryPicker()) {
    // Firefox/Safari — data lives in localStorage, always available.
    const adapter = new LocalStorageAdapter(rootDir);
    return { manifestAdapter: adapter, workspaceAdapter: adapter, rootDir };
  }
  // FSA: can't re-attach silently; caller should show a re-open affordance.
  return null;
}

export async function openWorkspaceDirectory(): Promise<OpenedWorkspace | null> {
  if (isInTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({ directory: true });
    if (!result || typeof result !== "string") return null;
    const adapter = new TauriFsAdapter();
    return { manifestAdapter: adapter, workspaceAdapter: adapter, rootDir: result };
  }

  if (supportsDirectoryPicker()) {
    const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    // Request readwrite permission upfront so first save doesn't prompt mid-edit.
    const perm = await dirHandle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") return null;
    const rootDir = "/" + dirHandle.name;
    const adapter = new FsaAdapter(dirHandle, rootDir);
    return { manifestAdapter: adapter, workspaceAdapter: adapter, rootDir };
  }

  // Firefox/Safari fallback — localStorage-backed virtual workspace.
  const rootDir = "/workspace";
  const adapter = new LocalStorageAdapter(rootDir);
  return { manifestAdapter: adapter, workspaceAdapter: adapter, rootDir };
}

// ---------------------------------------------------------------------------
// Manifest parsing helpers
// ---------------------------------------------------------------------------

const registryImportMatcher = new RegistryAdapter();

export function classifyImport(source: string): ImportKind {
  if (source.startsWith("pkg:") || /^https?:\/\//.test(source)) return "remote";
  if (isRegistryImportSource(source) && registryImportMatcher.supports(source)) return "registry";
  return "local";
}

export function buildParsedManifest(filePath: string, docs: ResourceManifest[]): ParsedManifest {
  const moduleDoc = docs.find((r) => isModuleKind(r.kind));
  const moduleKind: ModuleKind = moduleDoc?.kind === "Telo.Library" ? "Library" : "Application";

  const imports: ParsedImport[] = docs
    .filter((r) => r.kind === "Telo.Import")
    .map((r) => ({
      name: r.metadata.name as string,
      source: (r as Record<string, unknown>).source as string,
      importKind: classifyImport((r as Record<string, unknown>).source as string),
      variables: (r as Record<string, unknown>).variables as Record<string, unknown> | undefined,
      secrets: (r as Record<string, unknown>).secrets as Record<string, unknown> | undefined,
    }));

  const resources: ParsedResource[] = docs
    .filter((r) => !isModuleKind(r.kind) && r.kind !== "Telo.Import")
    .map((r) => {
      const { kind, metadata, ...rest } = r as Record<string, unknown> & {
        kind: string;
        metadata: { name: string; module?: string; source?: string };
      };
      return {
        kind,
        name: metadata.name,
        module: metadata.module,
        fields: rest as Record<string, unknown>,
        sourceFile: metadata.source,
      };
    });

  const rawTargets =
    ((moduleDoc as Record<string, unknown> | undefined)?.targets as string[] | undefined) ?? [];
  if (moduleKind === "Library" && rawTargets.length > 0) {
    throw new Error(
      `Telo.Library at ${filePath} must not declare 'targets'. Targets are Application-only.`,
    );
  }

  const include = (moduleDoc as Record<string, unknown> | undefined)?.include as
    | string[]
    | undefined;

  const moduleMeta = moduleDoc as Record<string, unknown> | undefined;

  return {
    filePath,
    kind: moduleKind,
    metadata: {
      name:
        (moduleDoc?.metadata.name as string | undefined) ??
        filePath
          .split("/")
          .pop()
          ?.replace(/\.ya?ml$/, "") ??
        "unknown",
      version: moduleDoc?.metadata.version as string | undefined,
      description: moduleDoc?.metadata.description as string | undefined,
      namespace: (moduleDoc?.metadata as Record<string, unknown>)?.namespace as string | undefined,
      variables: moduleMeta?.variables as Record<string, unknown> | undefined,
      secrets: moduleMeta?.secrets as Record<string, unknown> | undefined,
    },
    targets: rawTargets,
    imports,
    resources,
    ...(include?.length ? { include } : {}),
  };
}

// ---------------------------------------------------------------------------
// Workspace loader
// ---------------------------------------------------------------------------

// Creates ManifestAdapters for all enabled registry servers in settings.
export function createRegistryAdapters(settings: AppSettings): ManifestAdapter[] {
  function createSettingsRegistryAdapter(registryUrl: string): ManifestAdapter {
    const baseUrl = registryUrl.replace(/\/+$/, "");
    return {
      supports(url: string): boolean {
        return isRegistryImportSource(url);
      },
      async read(moduleRef: string): Promise<{ text: string; source: string }> {
        const atIdx = moduleRef.lastIndexOf("@");
        if (atIdx <= 0 || atIdx === moduleRef.length - 1) {
          throw new Error(
            `Invalid module reference '${moduleRef}', expected namespace/name@version`,
          );
        }

        const modulePath = moduleRef.slice(0, atIdx);
        const rawVersion = moduleRef.slice(atIdx + 1);
        const version = rawVersion.startsWith("v") ? rawVersion.substring(1) : rawVersion;
        const fetchUrl = `${baseUrl}/${modulePath}/${version}/${DEFAULT_MANIFEST_FILENAME}`;

        const response = await fetch(fetchUrl);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch manifest ${moduleRef} from ${baseUrl}: ${response.status} ${response.statusText}`,
          );
        }

        return { text: await response.text(), source: fetchUrl };
      },
      resolveRelative(base: string, relative: string): string {
        const baseUrlForRelative = this.supports(base)
          ? (() => {
              const atIdx = base.lastIndexOf("@");
              const modulePath = base.slice(0, atIdx);
              const rawVersion = base.slice(atIdx + 1);
              const version = rawVersion.startsWith("v") ? rawVersion.substring(1) : rawVersion;
              return `${baseUrl}/${modulePath}/${version}`;
            })()
          : base;

        const baseWithSlash = baseUrlForRelative.endsWith("/")
          ? baseUrlForRelative
          : `${baseUrlForRelative}/`;
        return new URL(relative, baseWithSlash).href;
      },
    };
  }

  return settings.registryServers
    .filter((s) => s.enabled)
    .map((s) => createSettingsRegistryAdapter(s.url));
}

function resolveDepPath(adapter: ManifestAdapter, filePath: string, source: string): string {
  return source.startsWith(".") || source.startsWith("/")
    ? adapter.resolveRelative(filePath, source)
    : source;
}

/**
 * Walks the workspace root and returns paths of every `telo.yaml` found,
 * skipping SCAN_EXCLUSIONS directories.
 */
export async function scanWorkspace(
  rootDir: string,
  adapter: WorkspaceAdapter,
): Promise<string[]> {
  const found: string[] = [];
  const rootPrefix = rootDir.endsWith("/") ? rootDir : rootDir + "/";

  function isExcluded(fullPath: string, name: string): boolean {
    if (SCAN_EXCLUDED_NAMES.has(name)) return true;
    const rel = fullPath.startsWith(rootPrefix) ? fullPath.slice(rootPrefix.length) : fullPath;
    return SCAN_EXCLUDED_RELATIVE_PATHS.includes(rel);
  }

  async function walk(dir: string): Promise<void> {
    let entries: DirEntry[];
    try {
      entries = await adapter.listDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = pathJoin(dir, entry.name);
      if (isExcluded(fullPath, entry.name)) continue;
      if (entry.isDirectory) {
        await walk(fullPath);
      } else if (entry.name === DEFAULT_MANIFEST_FILENAME) {
        found.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return found;
}

/**
 * Loads sub-graphs for any imports in the active module that aren't already in
 * the workspace's module map. Call this after replacing a manifest (e.g. from
 * source editing) to resolve newly-added or changed imports.
 */
export async function reconcileImports(
  workspace: Workspace,
  modulePath: string,
  adapter: ManifestAdapter,
  extraAdapters: ManifestAdapter[] = [],
): Promise<Workspace> {
  const manifest = workspace.modules.get(modulePath);
  if (!manifest) return workspace;

  const modules = new Map(workspace.modules);
  const importGraph = new Map(workspace.importGraph);
  const importedBy = new Map(workspace.importedBy);
  const prevDeps = new Set(importGraph.get(modulePath) ?? []);
  const deps = new Set<string>();

  const resolvedImports: ParsedImport[] = [];
  for (const imp of manifest.imports) {
    let resolvedPath = imp.resolvedPath ?? resolveDepPath(adapter, modulePath, imp.source);

    if (!modules.has(resolvedPath)) {
      try {
        resolvedPath = await mergeSubGraph(
          resolvedPath,
          modules,
          importGraph,
          importedBy,
          adapter,
          extraAdapters,
        );
      } catch {
        // Import loading failed — leave it unresolved at the originally-resolved path.
      }
    }

    resolvedImports.push({ ...imp, resolvedPath });
    deps.add(resolvedPath);

    if (!importedBy.has(resolvedPath)) importedBy.set(resolvedPath, new Set());
    importedBy.get(resolvedPath)!.add(modulePath);
  }

  modules.set(modulePath, { ...manifest, imports: resolvedImports });

  // Prune stale reverse edges for imports that were removed in this edit.
  // Without this, a source-edit deletion would leave the old dep listed in
  // importedBy, so the no-importers badge wouldn't reappear until a full
  // workspace reload.
  for (const stale of prevDeps) {
    if (deps.has(stale)) continue;
    const parents = importedBy.get(stale);
    if (!parents) continue;
    parents.delete(modulePath);
    if (parents.size === 0) importedBy.delete(stale);
  }

  importGraph.set(modulePath, deps);
  return { rootDir: workspace.rootDir, modules, importGraph, importedBy };
}

/**
 * Loads every module in the workspace directory tree, then resolves each
 * module's imports: workspace-local imports are wired to already-loaded
 * modules; registry/remote imports have their sub-graphs loaded.
 */
export async function loadWorkspace(
  rootDir: string,
  manifestAdapter: ManifestAdapter,
  workspaceAdapter: WorkspaceAdapter,
  extraAdapters: ManifestAdapter[] = [],
): Promise<Workspace> {
  const modulePaths = await scanWorkspace(rootDir, workspaceAdapter);

  const loader = createEditorLoader(manifestAdapter, extraAdapters);
  const modules = new Map<string, ParsedManifest>();
  const importGraph = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();

  // Phase 1: parse every discovered module (includes expand during loadModule).
  for (const filePath of modulePaths) {
    try {
      const docs = (await loader.loadModule(filePath)) as ResourceManifest[];
      modules.set(filePath, buildParsedManifest(filePath, docs));
    } catch (err) {
      console.error(`Failed to load workspace module ${filePath}:`, err);
    }
  }

  // Phase 2a: load external (registry/remote) import targets into the modules
  // map so Phase 2b can resolve every edge without recursive sub-graph calls.
  for (const parsed of modules.values()) {
    for (const imp of parsed.imports) {
      if (imp.importKind === "local") continue;
      const depPath = resolveDepPath(manifestAdapter, parsed.filePath, imp.source);
      if (modules.has(depPath)) continue;
      try {
        const subGraph = await loader.loadModuleGraph(depPath, (url, err) => {
          console.error(`Failed to load imported module ${url}:`, err);
        });
        for (const [subPath, subDocs] of subGraph) {
          if (modules.has(subPath)) continue;
          modules.set(subPath, buildParsedManifest(subPath, subDocs));
        }
      } catch (err) {
        console.error(`Failed to resolve import ${imp.source} in ${parsed.filePath}:`, err);
      }
    }
  }

  // Phase 2b: rebuild each module's imports with resolvedPath set, and wire
  // up graph edges. Imports are produced as new ParsedImport objects; the
  // originals from Phase 1 parsing are discarded to keep the returned workspace
  // fully owned by this call (no shared mutable references with any caller).
  //
  // Iterate over a snapshot so this stays safe if a future edit ever inserts
  // new keys mid-loop — today's re-sets to existing keys are fine per Map
  // semantics, but snapshotting removes that implicit invariant.
  for (const [filePath, parsed] of [...modules.entries()]) {
    const deps = new Set<string>();
    const resolvedImports = parsed.imports.map((imp) => {
      const depPath = resolveDepPath(manifestAdapter, filePath, imp.source);
      deps.add(depPath);
      if (!importedBy.has(depPath)) importedBy.set(depPath, new Set());
      importedBy.get(depPath)!.add(filePath);
      return { ...imp, resolvedPath: depPath };
    });
    modules.set(filePath, { ...parsed, imports: resolvedImports });
    importGraph.set(filePath, deps);
  }

  return { rootDir, modules, importGraph, importedBy };
}

// ---------------------------------------------------------------------------
// Module creation + removal (workspace-backed)
// ---------------------------------------------------------------------------

export interface CreateModuleOptions {
  kind: ModuleKind;
  relativePath: string;
  name: string;
}

/** Creates a new module directory with a telo.yaml inside the workspace,
 *  persists it via the WorkspaceAdapter, and returns the updated Workspace. */
export async function createModule(
  workspace: Workspace,
  options: CreateModuleOptions,
  adapter: WorkspaceAdapter,
): Promise<Workspace> {
  const { kind, relativePath, name } = options;
  const cleanRelative = relativePath.replace(/^\/+|\/+$/g, "");
  if (!cleanRelative) throw new Error(`Module path cannot be empty`);

  const moduleDir = pathJoin(workspace.rootDir, cleanRelative);
  const filePath = pathJoin(moduleDir, DEFAULT_MANIFEST_FILENAME);

  if (workspace.modules.has(filePath)) {
    throw new Error(`Module already exists at ${filePath}`);
  }

  await adapter.createDir(moduleDir);

  const manifest: ParsedManifest = {
    filePath,
    kind,
    metadata: { name, version: "1.0.0" },
    targets: [],
    imports: [],
    resources: [],
  };
  const yaml = renderManifestYaml(manifest);
  await adapter.writeFile(filePath, yaml);

  const modules = new Map(workspace.modules);
  modules.set(filePath, manifest);
  const importGraph = new Map(workspace.importGraph);
  importGraph.set(filePath, new Set());
  const importedBy = new Map(workspace.importedBy);

  return { rootDir: workspace.rootDir, modules, importGraph, importedBy };
}

/** Writes the module's YAML back to disk — owner file + any partial files
 *  resolved via `include:`. Uses getMultiFileSnapshots so include ownership
 *  is preserved for modules split across multiple files. */
export async function saveModule(
  manifest: ParsedManifest,
  adapter: WorkspaceAdapter,
): Promise<void> {
  const snapshots = getMultiFileSnapshots(manifest);
  for (const { filePath, yaml } of snapshots) {
    await adapter.writeFile(filePath, yaml);
  }
}

/** Deletes a module directory from disk and removes any references to it
 *  from importers (drops their Telo.Import entries pointing at the target). */
export async function deleteModule(
  workspace: Workspace,
  filePath: string,
  adapter: WorkspaceAdapter,
): Promise<Workspace> {
  const moduleDir = pathDirname(filePath);
  await adapter.delete(moduleDir);

  const modules = new Map(workspace.modules);
  modules.delete(filePath);

  // Drop imports in every importer that point at the deleted module.
  const importers = workspace.importedBy.get(filePath);
  if (importers) {
    for (const importerPath of importers) {
      const importer = modules.get(importerPath);
      if (!importer) continue;
      const updated = {
        ...importer,
        imports: importer.imports.filter((imp) => imp.resolvedPath !== filePath),
      };
      modules.set(importerPath, updated);
      try {
        await saveModule(updated, adapter);
      } catch (err) {
        console.error(`Failed to persist updated importer ${importerPath}:`, err);
      }
    }
  }

  // Rebuild graphs.
  const importGraph = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();
  for (const [path, m] of modules) {
    const deps = new Set<string>();
    importGraph.set(path, deps);
    for (const imp of m.imports) {
      if (!imp.resolvedPath) continue;
      deps.add(imp.resolvedPath);
      if (!importedBy.has(imp.resolvedPath)) importedBy.set(imp.resolvedPath, new Set());
      importedBy.get(imp.resolvedPath)!.add(path);
    }
  }

  return { rootDir: workspace.rootDir, modules, importGraph, importedBy };
}

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------

export function getAvailableKinds(workspace: Workspace, manifest: ParsedManifest): AvailableKind[] {
  const result: AvailableKind[] = [];
  for (const imp of manifest.imports) {
    if (!imp.resolvedPath) continue;
    const mod = workspace.modules.get(imp.resolvedPath);
    if (!mod) continue;
    for (const r of mod.resources) {
      if (r.kind !== "Telo.Definition") continue;
      result.push({
        fullKind: `${imp.name}.${r.name}`,
        alias: imp.name,
        kindName: r.name,
        capability: r.fields.capability as string,
        topology: typeof r.fields.topology === "string" ? (r.fields.topology as string) : undefined,
        schema: (r.fields.schema ?? {}) as Record<string, unknown>,
      });
    }
  }
  return result;
}

/** Returns true if `libraryPath` is transitively imported by any Application
 *  in the workspace. Used to mark "no importers" on unwired libraries. */
export function hasApplicationImporter(workspace: Workspace, libraryPath: string): boolean {
  const visited = new Set<string>();
  const queue: string[] = [libraryPath];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const importers = workspace.importedBy.get(current);
    if (!importers) continue;
    for (const importerPath of importers) {
      const importer = workspace.modules.get(importerPath);
      if (!importer) continue;
      if (importer.kind === "Application") return true;
      queue.push(importerPath);
    }
  }
  return false;
}

/** True when `filePath` belongs to the workspace directory (not an external
 *  import). Used to decide which modules appear in the WorkspaceTree. */
export function isWorkspaceModule(workspace: Workspace, filePath: string): boolean {
  const root = workspace.rootDir.endsWith("/") ? workspace.rootDir : workspace.rootDir + "/";
  return filePath.startsWith(root);
}

// ---------------------------------------------------------------------------
// YAML rendering
// ---------------------------------------------------------------------------

function yamlScalar(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (text === "" || /[:#\-\[\]{}\n]|^\s|\s$/.test(text)) {
    return JSON.stringify(text);
  }
  return text;
}

function yamlBlockScalar(text: string, indent: number): string {
  const pad = " ".repeat(indent);
  const blockLines = text.split("\n");
  const hasTrailingNewline = text.endsWith("\n");
  const contentLines = hasTrailingNewline ? blockLines.slice(0, -1) : blockLines;
  const header = hasTrailingNewline ? "|" : "|-";
  return header + "\n" + contentLines.map((l) => (l.length > 0 ? `${pad}${l}` : "")).join("\n");
}

function pushYaml(lines: string[], value: unknown, indent: number): void {
  const pad = " ".repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}[]`);
      return;
    }
    for (const item of value) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        lines.push(`${pad}-`);
        pushYaml(lines, item, indent + 2);
      } else if (Array.isArray(item)) {
        lines.push(`${pad}-`);
        pushYaml(lines, item, indent + 2);
      } else {
        lines.push(`${pad}- ${yamlScalar(item)}`);
      }
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      lines.push(`${pad}{}`);
      return;
    }

    for (const [key, entry] of entries) {
      if (Array.isArray(entry) || (entry !== null && typeof entry === "object")) {
        lines.push(`${pad}${key}:`);
        pushYaml(lines, entry, indent + 2);
      } else if (typeof entry === "string" && entry.includes("\n")) {
        lines.push(`${pad}${key}: ${yamlBlockScalar(entry, indent + 2)}`);
      } else {
        lines.push(`${pad}${key}: ${yamlScalar(entry)}`);
      }
    }
    return;
  }

  if (typeof value === "string" && value.includes("\n")) {
    lines.push(`${pad}${yamlBlockScalar(value, indent + 2)}`);
    return;
  }
  lines.push(`${pad}${yamlScalar(value)}`);
}

function dumpYamlDoc(doc: Record<string, unknown>): string {
  const lines: string[] = [];
  pushYaml(lines, doc, 0);
  return lines.join("\n");
}

export function toManifestDocs(manifest: ParsedManifest): Record<string, unknown>[] {
  const moduleDoc: Record<string, unknown> = {
    kind: manifest.kind === "Application" ? "Telo.Application" : "Telo.Library",
    metadata: {
      name: manifest.metadata.name,
      ...(manifest.metadata.version ? { version: manifest.metadata.version } : {}),
      ...(manifest.metadata.description ? { description: manifest.metadata.description } : {}),
    },
  };

  if (manifest.metadata.namespace) (moduleDoc.metadata as Record<string, unknown>).namespace = manifest.metadata.namespace;
  if (manifest.metadata.variables) moduleDoc.variables = manifest.metadata.variables;
  if (manifest.metadata.secrets) moduleDoc.secrets = manifest.metadata.secrets;
  if (manifest.include?.length) moduleDoc.include = manifest.include;
  if (manifest.kind === "Application" && manifest.targets.length > 0) moduleDoc.targets = manifest.targets;

  const importDocs = manifest.imports.map((imp) => ({
    kind: "Telo.Import",
    metadata: { name: imp.name },
    source: imp.source,
    ...(imp.variables ? { variables: imp.variables } : {}),
    ...(imp.secrets ? { secrets: imp.secrets } : {}),
  }));

  const resourceDocs = manifest.resources.map((resource) => ({
    kind: resource.kind,
    metadata: {
      name: resource.name,
      ...(resource.module ? { module: resource.module } : {}),
    },
    ...resource.fields,
  }));

  return [moduleDoc, ...importDocs, ...resourceDocs];
}

export function renderManifestYaml(manifest: ParsedManifest): string {
  const docs = toManifestDocs(manifest);
  if (docs.length === 0) return "";
  return docs.map((doc) => dumpYamlDoc(doc)).join("\n---\n");
}

/** Per-file YAML snapshots for a multi-file module. Resources are written
 *  back to their originating sourceFile rather than collapsed into the owner.
 *
 *  Keys are normalized before grouping so a kernel-stamped metadata.source
 *  that differs cosmetically from manifest.filePath (extra slashes, `./`,
 *  etc.) still groups with the owner rather than leaking into a header-less
 *  partial snapshot. */
export function getMultiFileSnapshots(
  manifest: ParsedManifest,
): Array<{ filePath: string; yaml: string }> {
  const ownerKey = normalizePath(manifest.filePath);
  const groups = new Map<string, ParsedResource[]>();
  for (const r of manifest.resources) {
    const file = normalizePath(r.sourceFile ?? manifest.filePath);
    let list = groups.get(file);
    if (!list) {
      list = [];
      groups.set(file, list);
    }
    list.push(r);
  }

  const snapshots: Array<{ filePath: string; yaml: string }> = [];

  const ownerResources = groups.get(ownerKey) ?? [];
  const ownerManifest: ParsedManifest = { ...manifest, resources: ownerResources };
  const ownerDocs = toManifestDocs(ownerManifest);
  snapshots.push({
    filePath: manifest.filePath,
    yaml: ownerDocs.map((doc) => dumpYamlDoc(doc)).join("\n---\n"),
  });

  for (const [file, resources] of groups) {
    if (file === ownerKey) continue;
    const docs = resources.map((r) => ({
      kind: r.kind,
      metadata: {
        name: r.name,
        ...(r.module ? { module: r.module } : {}),
      },
      ...r.fields,
    }));
    snapshots.push({
      filePath: file,
      yaml: docs.map((doc) => dumpYamlDoc(doc)).join("\n---\n"),
    });
  }

  return snapshots;
}
