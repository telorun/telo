import type { ManifestAdapter } from "@telorun/analyzer";
import { DEFAULT_MANIFEST_FILENAME, Loader, RegistryAdapter, isModuleKind } from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import type {
  AppSettings,
  AvailableKind,
  DirEntry,
  ImportKind,
  ModuleDocument,
  ModuleKind,
  ParsedImport,
  ParsedManifest,
  ParsedResource,
  RegistryServer,
  Workspace,
  WorkspaceAdapter,
} from "./model";
import {
  addImportDocument,
  addResourceDocument,
  applyEdit,
  buildInitialModuleDocument,
  diffFields,
  findDocForResource,
  parseModuleDocument,
  removeImportDocument,
  removeResourceDocument,
  serializeModuleDocument,
  type EditOp,
} from "./yaml-document";


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

/** Wraps a disk-backed ManifestAdapter so `read()` first checks a
 *  `ModuleDocument` map and serves the in-memory text when present. Falls
 *  through to disk for files not yet tracked (first load, imports, partials
 *  before Phase-1 post-processing adds them). All other adapter methods
 *  (`resolveRelative`, `expandGlob`, `resolveOwnerOf`) delegate to the disk
 *  adapter because glob expansion and path resolution still require real
 *  filesystem knowledge.
 *
 *  The map is passed by reference, so callers that mutate `documents` after
 *  constructing the adapter see the updates on subsequent `read()` calls —
 *  which is how Phase-1 post-processing populates partial ASTs mid-load. */
function createInMemoryManifestAdapter(
  documents: Map<string, ModuleDocument>,
  disk: ManifestAdapter,
): ManifestAdapter {
  return {
    supports(url: string): boolean {
      return disk.supports(url);
    },
    async read(url: string): Promise<{ text: string; source: string }> {
      const doc = documents.get(normalizePath(url));
      if (doc) return { text: doc.text, source: url };
      return disk.read(url);
    },
    resolveRelative(base: string, relative: string): string {
      return disk.resolveRelative(base, relative);
    },
    expandGlob: disk.expandGlob ? (base, patterns) => disk.expandGlob!(base, patterns) : undefined,
    resolveOwnerOf: disk.resolveOwnerOf ? (url) => disk.resolveOwnerOf!(url) : undefined,
  };
}

/** Combines a local disk adapter with registry/extra adapters into a single
 *  adapter whose `read()` routes each URL to the first adapter that `supports()`
 *  it (extras first, local last). Used when populating `ModuleDocument`s for
 *  imported modules — the local adapter alone can't read registry URLs, and
 *  `populateModuleDocument` only takes one adapter. */
function createChainedManifestAdapter(
  localAdapter: ManifestAdapter,
  extraAdapters: ManifestAdapter[],
): ManifestAdapter {
  return {
    supports(url: string): boolean {
      return extraAdapters.some((a) => a.supports(url)) || localAdapter.supports(url);
    },
    async read(url: string): Promise<{ text: string; source: string }> {
      for (const a of extraAdapters) {
        if (a.supports(url)) return a.read(url);
      }
      return localAdapter.read(url);
    },
    resolveRelative(base: string, relative: string): string {
      return localAdapter.resolveRelative(base, relative);
    },
    expandGlob: localAdapter.expandGlob
      ? (base, patterns) => localAdapter.expandGlob!(base, patterns)
      : undefined,
    resolveOwnerOf: localAdapter.resolveOwnerOf
      ? (url) => localAdapter.resolveOwnerOf!(url)
      : undefined,
  };
}

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

export function normalizePath(p: string): string {
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
// Glob matching (browser-safe; no minimatch dependency)
// ---------------------------------------------------------------------------

/** Converts a glob pattern to a regex. Handles `*` (any chars except `/`),
 *  `**` (any chars including `/`), and `?` (single char except `/`). Brace
 *  and character-class expansion are intentionally unsupported — they are not
 *  required by current include patterns and would bloat this function. */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if ("\\^$+.()=!|:{}[]".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp("^" + re + "$");
}

/** True when a pattern contains any glob metacharacter. */
export function hasGlobChars(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

/** Recursively collects all file paths under a directory via a
 *  WorkspaceAdapter's `listDir`. Directories listed in SCAN_EXCLUDED_NAMES
 *  are skipped. Returned paths are absolute (joined with the input dir). */
async function listAllFilesRecursive(
  dir: string,
  adapter: WorkspaceAdapter,
): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries: DirEntry[];
    try {
      entries = await adapter.listDir(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SCAN_EXCLUDED_NAMES.has(entry.name)) continue;
      const full = pathJoin(current, entry.name);
      if (entry.isDirectory) {
        await walk(full);
      } else {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

/** Generic glob expander. Given a `base` source (an owner telo.yaml path),
 *  expands each pattern relative to the base's directory and returns matching
 *  absolute file paths. Used by all three browser-side adapters to avoid
 *  duplicating the walk-and-match logic three times. `listFiles` is the
 *  adapter-specific piece that enumerates the directory tree. */
async function expandGlobViaList(
  base: string,
  patterns: string[],
  listFiles: (dir: string) => Promise<string[]>,
): Promise<string[]> {
  const baseDir = pathDirname(base);
  const allFiles = await listFiles(baseDir);
  const normalizedPatterns = patterns.map((p) => p.replace(/^\.\//, ""));
  const regexps = normalizedPatterns.map((p) =>
    hasGlobChars(p) ? globToRegExp(p) : null,
  );

  const matched = new Set<string>();
  for (const file of allFiles) {
    const rel = pathRelative(baseDir, file);
    for (let i = 0; i < normalizedPatterns.length; i++) {
      const re = regexps[i];
      if (re) {
        if (re.test(rel)) matched.add(file);
      } else if (rel === normalizedPatterns[i]) {
        matched.add(file);
      }
    }
  }
  return [...matched].sort();
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
  documents: Map<string, ModuleDocument>,
  adapter: ManifestAdapter,
  extraAdapters: ManifestAdapter[],
): Promise<string> {
  const inMemoryAdapter = createInMemoryManifestAdapter(documents, adapter);
  const loader = createEditorLoader(inMemoryAdapter, extraAdapters);
  const subGraph = await loader.loadModuleGraph(entryPath, (url, err) => {
    console.error(`Failed to load module ${url}:`, err);
  });

  // Registry/remote adapters may resolve `entryPath` to a differently-keyed URL.
  let actualRoot = entryPath;
  if (!subGraph.has(entryPath) && subGraph.size > 0) {
    actualRoot = subGraph.keys().next().value as string;
  }

  // Chained adapter so ModuleDocument population can read registry URLs —
  // the bare local adapter only supports disk paths and silently fails for
  // anything served by a registry/remote extra adapter.
  const chainedAdapter = createChainedManifestAdapter(adapter, extraAdapters);

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

    // Populate ModuleDocument for the newly loaded module (owner file plus
    // any partial files it declared via `include:`).
    if (!documents.has(normalizePath(filePath))) {
      await populateModuleDocument(filePath, documents, chainedAdapter);
    }
    await collectPartialDocuments(docs, filePath, documents, chainedAdapter);
  }

  return actualRoot;
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

  async expandGlob(base: string, patterns: string[]): Promise<string[]> {
    return expandGlobViaList(base, patterns, (dir) => listAllFilesRecursive(dir, this));
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

  async expandGlob(base: string, patterns: string[]): Promise<string[]> {
    return expandGlobViaList(base, patterns, (dir) => listAllFilesRecursive(dir, this));
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

  async expandGlob(base: string, patterns: string[]): Promise<string[]> {
    return expandGlobViaList(base, patterns, (dir) => listAllFilesRecursive(dir, this));
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

/** Builds a placeholder manifest for a module whose YAML couldn't be parsed.
 *  Keeps the module visible in the workspace tree so the user can open Source
 *  view and fix the issue. Best-effort name extraction from the raw text; if
 *  that fails too, fall back to the file's parent directory name. */
export async function buildFailureManifest(
  filePath: string,
  error: unknown,
  adapter: WorkspaceAdapter,
): Promise<ParsedManifest> {
  let rawYaml = "";
  try {
    rawYaml = await adapter.readFile(filePath);
  } catch {
    // If we can't even read the raw file, keep rawYaml empty; the source view
    // will show an empty editor and the banner will still explain the error.
  }

  const kindMatch = /^\s*kind:\s*Telo\.(Library|Application)\b/m.exec(rawYaml);
  const kind: ModuleKind = kindMatch?.[1] === "Library" ? "Library" : "Application";

  const nameMatch = /metadata:\s*\n(?:\s+[^\n]*\n)*?\s+name:\s*["']?([^"'\n]+)["']?/m.exec(rawYaml);
  const fallbackName = filePath.split("/").slice(-2, -1)[0] ?? "module";

  return {
    filePath,
    kind,
    metadata: { name: (nameMatch?.[1] ?? fallbackName).trim() },
    targets: [],
    imports: [],
    resources: [],
    loadError: error instanceof Error ? error.message : String(error),
    rawYaml,
  };
}

export function buildParsedManifest(filePath: string, docs: ResourceManifest[]): ParsedManifest {
  const moduleDoc = docs.find((r) => isModuleKind(r.kind));
  const moduleKind: ModuleKind = moduleDoc?.kind === "Telo.Library" ? "Library" : "Application";

  const imports: ParsedImport[] = docs
    // Require string name + source so transient source-view typing
    // (user hasn't finished typing `name:` or `source:` yet) doesn't
    // surface as null-identified ParsedImport entries that downstream
    // views would crash on.
    .filter((r) => {
      if (r.kind !== "Telo.Import") return false;
      const name = (r.metadata as { name?: unknown } | undefined)?.name;
      const source = (r as Record<string, unknown>).source;
      return typeof name === "string" && typeof source === "string";
    })
    .map((r) => ({
      name: r.metadata.name as string,
      source: (r as Record<string, unknown>).source as string,
      importKind: classifyImport((r as Record<string, unknown>).source as string),
      variables: (r as Record<string, unknown>).variables as Record<string, unknown> | undefined,
      secrets: (r as Record<string, unknown>).secrets as Record<string, unknown> | undefined,
    }));

  const resources: ParsedResource[] = docs
    // Require a string `kind` and a string `metadata.name` before projecting
    // a doc into the resources array. Transient source-view typing states
    // (e.g. `kind:` with value not yet entered → null, or a kind-less
    // standalone doc) would otherwise produce ParsedResource entries with
    // null/undefined identifiers that downstream views can't render.
    .filter((r) => {
      if (typeof r.kind !== "string") return false;
      if (isModuleKind(r.kind) || r.kind === "Telo.Import") return false;
      const name = (r.metadata as { name?: unknown } | undefined)?.name;
      return typeof name === "string";
    })
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

/** Rebuilds the per-module `${kind}::${name}` → `{filePath, docIndex}` side
 *  table from scratch. Outer key is the owner module's canonicalized filePath;
 *  inner key scopes resource identity to a single module so resources with the
 *  same kind/name in different modules don't collide.
 *
 *  Incremental patching would be fragile under resource renames (a
 *  `metadata.name` change shifts the key) and doc-index shifts (add / remove
 *  shifts everything after it). A full rebuild on every `documents` change is
 *  one pass over the docs array per module; cheap at workspace sizes of up
 *  to thousands of modules. */
function buildResourceDocIndex(
  modules: Map<string, ParsedManifest>,
  documents: Map<string, ModuleDocument>,
): Map<string, Map<string, { filePath: string; docIndex: number }>> {
  const index = new Map<string, Map<string, { filePath: string; docIndex: number }>>();
  for (const [modulePath, manifest] of modules) {
    const ownerKey = normalizePath(modulePath);
    const inner = new Map<string, { filePath: string; docIndex: number }>();

    // Imports are not indexed: `addImportViaAst` / `removeImportViaAst`
    // locate the owner doc via `documents.get(modulePath)` and look up
    // Telo.Import docs directly with `findDocForResource`. Adding them to
    // this side-table would be dead state.

    for (const r of manifest.resources) {
      const sourceKey = normalizePath(r.sourceFile ?? modulePath);
      const modDoc = documents.get(sourceKey);
      if (!modDoc) continue;
      const docIndex = findDocForResource(modDoc.docs, r.kind, r.name);
      if (docIndex === undefined) continue;
      inner.set(`${r.kind}::${r.name}`, { filePath: sourceKey, docIndex });
    }

    index.set(ownerKey, inner);
  }
  return index;
}

/** Re-derives the `ParsedManifest` for a module from its AST (`workspace.documents`).
 *  Used after every form-driven AST mutation (Phase 3) and after source-view
 *  edits (Phase 4) so views see the new state without directly mutating
 *  `ParsedManifest`. Also rebuilds `resourceDocIndex` because resource
 *  add/remove shifts the inner map.
 *
 *  Graph-derived fields are preserved across the re-projection:
 *   - For imports unchanged in `name` + `source`, `resolvedPath` is copied
 *     forward from the previous projection.
 *   - For imports whose `source` changed (or new imports), `resolvedPath`
 *     is left `undefined` so the caller can decide whether to trigger
 *     `reconcileImports` to load the new target graph.
 *
 *  Partial-file discovery is taken from `prev.resources[].sourceFile` — we
 *  don't re-run `include:` glob expansion here. Source-view edits that
 *  change the module's `include:` list must explicitly re-resolve via a
 *  full workspace reload or a targeted re-include pass (out of scope). */
export function rebuildManifestFromDocuments(
  workspace: Workspace,
  modulePath: string,
): Workspace {
  const prev = workspace.modules.get(modulePath);
  if (!prev) return workspace;

  const partialPaths = new Set<string>();
  for (const r of prev.resources) {
    if (r.sourceFile && normalizePath(r.sourceFile) !== normalizePath(modulePath)) {
      partialPaths.add(r.sourceFile);
    }
  }

  const synthetic = astToResourceManifests(
    modulePath,
    workspace.documents,
    [...partialPaths],
  );
  const fresh = buildParsedManifest(modulePath, synthetic);

  const prevImportByName = new Map(prev.imports.map((imp) => [imp.name, imp]));
  const importsWithResolved = fresh.imports.map((imp) => {
    const p = prevImportByName.get(imp.name);
    if (p && p.source === imp.source) {
      return { ...imp, resolvedPath: p.resolvedPath };
    }
    return { ...imp, resolvedPath: undefined };
  });

  const modules = new Map(workspace.modules);
  modules.set(modulePath, { ...fresh, imports: importsWithResolved });
  const resourceDocIndex = buildResourceDocIndex(modules, workspace.documents);
  return { ...workspace, modules, resourceDocIndex };
}

/** True when at least one import in the module has `resolvedPath === undefined`
 *  — signals to the caller that `reconcileImports` should be run to load the
 *  new import target's sub-graph. */
export function hasUnresolvedImports(workspace: Workspace, modulePath: string): boolean {
  const manifest = workspace.modules.get(modulePath);
  if (!manifest) return false;
  return manifest.imports.some((imp) => !imp.resolvedPath);
}

/** Replaces a single `ModuleDocument` entry in the workspace. Produces a
 *  fresh `documents` Map so React consumers that key off Map identity see
 *  the change. Does NOT rebuild `modules` or `resourceDocIndex` — call
 *  `rebuildManifestFromDocuments` afterwards when the mutation changed
 *  resource/import structure, or skip the rebuild for field-only edits
 *  where the ParsedManifest structure is stable. */
function withModuleDocument(
  workspace: Workspace,
  filePath: string,
  modDoc: ModuleDocument,
): Workspace {
  const documents = new Map(workspace.documents);
  documents.set(normalizePath(filePath), modDoc);
  return { ...workspace, documents };
}

/** Applies a sequence of EditOps to one document inside the workspace's AST
 *  layer. The ops mutate `docs[docIndex]` in place (preserving comments on
 *  unchanged nodes); the result is bundled into a fresh `ModuleDocument` +
 *  fresh `documents` Map so React consumers see a new reference. The
 *  returned workspace has updated `documents` only — callers that also need
 *  a refreshed `ParsedManifest` / `resourceDocIndex` should follow up with
 *  `rebuildManifestFromDocuments`. */
export function applyOpsToDocument(
  workspace: Workspace,
  filePath: string,
  docIndex: number,
  ops: EditOp[],
): Workspace {
  if (ops.length === 0) return workspace;
  const key = normalizePath(filePath);
  const modDoc = workspace.documents.get(key);
  if (!modDoc) return workspace;

  let docs = modDoc.docs;
  for (const op of ops) {
    docs = applyEdit(docs, docIndex, op);
  }
  return withModuleDocument(workspace, filePath, { ...modDoc, docs });
}

/** Updates a resource's body fields in the AST. Diffs `oldFields` against
 *  `newFields` (convention: `undefined` → delete, `null` → explicit null,
 *  `""` → empty string, other → set), translates to EditOps rooted at the
 *  resource's document, applies them, and re-derives the ParsedManifest.
 *  Returns the original workspace when the resource has no AST entry
 *  (stale resourceDocIndex after a rename, parse error on the file, etc.). */
export function setResourceFields(
  workspace: Workspace,
  modulePath: string,
  kind: string,
  name: string,
  oldFields: Record<string, unknown>,
  newFields: Record<string, unknown>,
): Workspace {
  const indexEntry = workspace.resourceDocIndex
    .get(normalizePath(modulePath))
    ?.get(`${kind}::${name}`);
  if (!indexEntry) return workspace;

  const ops = diffFields(oldFields, newFields, "");
  if (ops.length === 0) return workspace;

  const updated = applyOpsToDocument(workspace, indexEntry.filePath, indexEntry.docIndex, ops);
  return rebuildManifestFromDocuments(updated, modulePath);
}

/** Appends a new resource document to the owner module's AST and re-derives
 *  the ParsedManifest. New resources always land in the owner file (not in
 *  a partial) — matches the current `handleCreateResource` behavior and
 *  keeps "moving resources between files" out of this path. */
export function createResourceViaAst(
  workspace: Workspace,
  modulePath: string,
  kind: string,
  name: string,
  fields: Record<string, unknown>,
): Workspace {
  const key = normalizePath(modulePath);
  const modDoc = workspace.documents.get(key);
  if (!modDoc) return workspace;

  const docs = addResourceDocument(modDoc.docs, kind, name, fields);
  const updated = withModuleDocument(workspace, modulePath, { ...modDoc, docs });
  return rebuildManifestFromDocuments(updated, modulePath);
}

/** Inserts a `Telo.Import` document into the owner module's AST, re-derives
 *  the ParsedManifest (which projects the new import with
 *  `resolvedPath: undefined`), then reconciles imports to resolve the new
 *  target's sub-graph and wire `importGraph` / `importedBy` edges.
 *
 *  Routing through `reconcileImports` (not the legacy `addImport`) is
 *  deliberate: `rebuildManifestFromDocuments` already places the new
 *  import into `manifest.imports` from the AST, so any helper that
 *  *appends* to that list would produce a duplicate entry.
 *  `reconcileImports` iterates the existing import list, resolves each
 *  one, and updates graph state without appending. */
export async function addImportViaAst(
  workspace: Workspace,
  modulePath: string,
  imp: ParsedImport,
  manifestAdapter: ManifestAdapter,
  extraAdapters: ManifestAdapter[] = [],
): Promise<Workspace> {
  const key = normalizePath(modulePath);
  const modDoc = workspace.documents.get(key);
  if (!modDoc) return workspace;

  const docs = addImportDocument(modDoc.docs, imp.name, imp.source, {
    variables: imp.variables,
    secrets: imp.secrets,
  });
  const astOnly = withModuleDocument(workspace, modulePath, { ...modDoc, docs });
  const rebuilt = rebuildManifestFromDocuments(astOnly, modulePath);
  return reconcileImports(rebuilt, modulePath, manifestAdapter, extraAdapters);
}

/** Removes a `Telo.Import` document from the owner module's AST and
 *  reconciles the import graph (pruning reverse edges for the dropped
 *  target). */
export async function removeImportViaAst(
  workspace: Workspace,
  modulePath: string,
  name: string,
  manifestAdapter: ManifestAdapter,
  extraAdapters: ManifestAdapter[] = [],
): Promise<Workspace> {
  const key = normalizePath(modulePath);
  const modDoc = workspace.documents.get(key);
  if (!modDoc) return workspace;

  const docs = removeImportDocument(modDoc.docs, name);
  if (docs === modDoc.docs) return workspace;

  const astOnly = withModuleDocument(workspace, modulePath, { ...modDoc, docs });
  const rebuilt = rebuildManifestFromDocuments(astOnly, modulePath);
  return reconcileImports(rebuilt, modulePath, manifestAdapter, extraAdapters);
}

/** Removes the old import and inserts a new one with the same alias but a
 *  different source. Resolves the new target's sub-graph via
 *  `addImportViaAst`'s reconcile step. */
export async function upgradeImportViaAst(
  workspace: Workspace,
  modulePath: string,
  name: string,
  newSource: string,
  manifestAdapter: ManifestAdapter,
  extraAdapters: ManifestAdapter[] = [],
): Promise<Workspace> {
  const after = await removeImportViaAst(
    workspace,
    modulePath,
    name,
    manifestAdapter,
    extraAdapters,
  );
  return addImportViaAst(
    after,
    modulePath,
    { name, source: newSource, importKind: classifyImport(newSource) },
    manifestAdapter,
    extraAdapters,
  );
}

/** Walks `workspace.documents` for the module's owner + listed partials and
 *  emits `ResourceManifest[]` enriched with `metadata.source` (canonical
 *  per-file path) and `metadata.module` (owner module name, stamped on
 *  resources declared in partials — mirrors what the analyzer Loader does in
 *  `loadPartialFile`). The output feeds straight into `buildParsedManifest`.
 */
function astToResourceManifests(
  ownerPath: string,
  documents: Map<string, ModuleDocument>,
  partialPaths: string[],
): ResourceManifest[] {
  const out: ResourceManifest[] = [];
  const ownerDoc = documents.get(normalizePath(ownerPath));
  if (!ownerDoc) return out;

  let ownerModuleName: string | undefined;
  for (const d of ownerDoc.docs) {
    const json = d.toJSON() as Record<string, unknown> | null;
    if (!json) continue;
    const kind = json.kind;
    if (typeof kind === "string" && isModuleKind(kind)) {
      const meta = json.metadata as Record<string, unknown> | undefined;
      if (meta && typeof meta.name === "string") ownerModuleName = meta.name;
    }
    const meta: Record<string, unknown> = {
      ...(json.metadata as Record<string, unknown> | undefined),
      source: ownerPath,
    };
    out.push({ ...json, metadata: meta } as ResourceManifest);
  }

  for (const partial of partialPaths) {
    const partialDoc = documents.get(normalizePath(partial));
    if (!partialDoc) continue;
    for (const d of partialDoc.docs) {
      const json = d.toJSON() as Record<string, unknown> | null;
      if (!json) continue;
      const meta: Record<string, unknown> = {
        ...(json.metadata as Record<string, unknown> | undefined),
        source: partial,
      };
      if (ownerModuleName && meta.module === undefined) meta.module = ownerModuleName;
      out.push({ ...json, metadata: meta } as ResourceManifest);
    }
  }
  return out;
}

/** Reads a file's text and parses it into a ModuleDocument, storing the
 *  result under `normalizePath(filePath)`. Safe to call repeatedly with the
 *  same path; re-parsing replaces the previous entry. On read failure the
 *  ModuleDocument is omitted entirely (not stored as a stub) so downstream
 *  `documents.get(...)` miss-vs-hit semantics stay unambiguous. */
async function populateModuleDocument(
  filePath: string,
  documents: Map<string, ModuleDocument>,
  adapter: ManifestAdapter,
): Promise<void> {
  const key = normalizePath(filePath);
  try {
    const { text } = await adapter.read(filePath);
    documents.set(key, parseModuleDocument(filePath, text));
  } catch (err) {
    console.error(`Failed to read ${filePath} for ModuleDocument:`, err);
  }
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
  const documents = new Map(workspace.documents);
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
          documents,
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
  const resourceDocIndex = buildResourceDocIndex(modules, documents);
  return { rootDir: workspace.rootDir, modules, importGraph, importedBy, documents, resourceDocIndex };
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

  const modules = new Map<string, ParsedManifest>();
  const importGraph = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();
  const documents = new Map<string, ModuleDocument>();

  // Phase 0: pre-populate documents for every scanned owner file. One disk
  // read per file; the in-memory adapter below serves subsequent reads of the
  // same file (including from inside the analyzer Loader) from this cache.
  for (const filePath of modulePaths) {
    await populateModuleDocument(filePath, documents, manifestAdapter);
  }

  // Fresh Loader per loadWorkspace call, backed by an in-memory adapter that
  // reads from `documents` and falls through to disk for files not yet
  // tracked (partial include targets, external imports). See the plan's
  // "Analyzer Loader is instantiated fresh per call" decision.
  const inMemoryAdapter = createInMemoryManifestAdapter(documents, manifestAdapter);
  const loader = createEditorLoader(inMemoryAdapter, extraAdapters);

  // Phase 1: parse every discovered module (includes expand during loadModule).
  // After each load, walk the returned manifests for any partial-file source
  // paths (from `include:` expansion) and populate their ModuleDocument too.
  for (const filePath of modulePaths) {
    try {
      const docs = (await loader.loadModule(filePath)) as ResourceManifest[];
      modules.set(filePath, buildParsedManifest(filePath, docs));
      await collectPartialDocuments(docs, filePath, documents, manifestAdapter);
    } catch (err) {
      console.error(`Failed to load workspace module ${filePath}:`, err);
      // Register a placeholder so the module still appears in the workspace
      // tree and the user can open its source to fix the parse issue.
      modules.set(filePath, await buildFailureManifest(filePath, err, workspaceAdapter));
    }
  }

  // Phase 2a: load external (registry/remote) import targets into the modules
  // map so Phase 2b can resolve every edge without recursive sub-graph calls.
  // Populate a ModuleDocument for each imported owner so `analyzeWorkspace`
  // (which routes through `documents`) sees their Telo.Definition docs — the
  // bare `manifestAdapter` can't read registry URLs, so chain in extras.
  const chainedAdapter = createChainedManifestAdapter(manifestAdapter, extraAdapters);
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
          if (!documents.has(normalizePath(subPath))) {
            await populateModuleDocument(subPath, documents, chainedAdapter);
          }
          await collectPartialDocuments(subDocs, subPath, documents, chainedAdapter);
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

  const resourceDocIndex = buildResourceDocIndex(modules, documents);
  return { rootDir, modules, importGraph, importedBy, documents, resourceDocIndex };
}

/** After loadModule returns, walk the ResourceManifest[] for distinct
 *  `metadata.source` values and populate a ModuleDocument for any source
 *  path not already tracked. This catches partial files expanded from
 *  `include:` patterns — they're not in `modulePaths` (scanWorkspace only
 *  finds telo.yaml files), so without this pass they'd have no AST entry
 *  and post-load edits that target resources in partials would fail. */
async function collectPartialDocuments(
  docs: ResourceManifest[],
  ownerPath: string,
  documents: Map<string, ModuleDocument>,
  adapter: ManifestAdapter,
): Promise<void> {
  const sources = new Set<string>();
  for (const doc of docs) {
    const src = (doc.metadata as { source?: unknown })?.source;
    if (typeof src === "string" && src !== ownerPath) sources.add(src);
  }
  for (const src of sources) {
    if (documents.has(normalizePath(src))) continue;
    await populateModuleDocument(src, documents, adapter);
  }
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
  const initialDoc = buildInitialModuleDocument(kind, name);
  const yaml = serializeModuleDocument([initialDoc]);
  await adapter.writeFile(filePath, yaml);

  const modules = new Map(workspace.modules);
  modules.set(filePath, manifest);
  const importGraph = new Map(workspace.importGraph);
  importGraph.set(filePath, new Set());
  const importedBy = new Map(workspace.importedBy);

  const documents = new Map(workspace.documents);
  documents.set(normalizePath(filePath), parseModuleDocument(filePath, yaml));
  const resourceDocIndex = buildResourceDocIndex(modules, documents);

  return { rootDir: workspace.rootDir, modules, importGraph, importedBy, documents, resourceDocIndex };
}

/** Writes the module's YAML back to disk by serializing each tracked
 *  `ModuleDocument` via `serializeModuleDocument`. No custom serializer; the
 *  `yaml` library's `Document#toString()` preserves comments, anchors,
 *  quoting, flow vs block style, and multi-document separators.
 *
 *  Discovers the module's files from the same two sources the loader
 *  populates: the owner `modulePath`, plus any `sourceFile` stamped on a
 *  resource by the analyzer (include-expanded partials).
 *
 *  Semantic-equality guard: skips the write for any file whose AST
 *  `.toJSON()` deep-equals the snapshot captured at load time
 *  (`ModuleDocument.loadedJson`). This prevents a no-op save from
 *  reformatting every file — the first save of a non-canonical file still
 *  reformats it once (YAML library normalizes quoting / whitespace on
 *  `String(doc)`), but that is a one-time cost per file.
 *
 *  Returns a new Workspace with updated `ModuleDocument` entries
 *  (`text` + `loadedJson`) for every file actually written, so subsequent
 *  save calls see the new state as canonical. Returns the input workspace
 *  unchanged when nothing was written. */
export async function saveModuleFromDocuments(
  workspace: Workspace,
  modulePath: string,
  adapter: WorkspaceAdapter,
): Promise<Workspace> {
  const manifest = workspace.modules.get(modulePath);
  if (!manifest) return workspace;

  const fileKeys = new Set<string>([normalizePath(modulePath)]);
  for (const r of manifest.resources) {
    if (r.sourceFile) fileKeys.add(normalizePath(r.sourceFile));
  }

  const documents = new Map(workspace.documents);
  let anyWritten = false;

  for (const key of fileKeys) {
    const modDoc = documents.get(key);
    if (!modDoc) continue;
    // A file with a parse error has its last-good docs attached; writing
    // them would destroy user edits-in-progress. Skip until the user fixes
    // the file via the source view.
    if (modDoc.parseError) continue;

    const currentJson = modDoc.docs.map((d) => d.toJSON());
    if (jsonDeepEqual(currentJson, modDoc.loadedJson)) continue;

    const text = serializeModuleDocument(modDoc.docs);
    await adapter.writeFile(modDoc.filePath, text);
    documents.set(key, { ...modDoc, text, loadedJson: currentJson });
    anyWritten = true;
  }

  if (!anyWritten) return workspace;
  return { ...workspace, documents };
}

/** Semantic deep-equality for AST snapshots. `yaml.Document#toJSON()` produces
 *  plain JSON-compatible structures (no Map/Set/Date/function), so stringify
 *  comparison is sound. Key order is preserved by `yaml` across repeated
 *  calls on the same document, so two snapshots of an unmutated document
 *  stringify identically. */
function jsonDeepEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Persists a module via the AST-based save path. Thin alias over
 *  `saveModuleFromDocuments` kept for call-site clarity in Editor.tsx —
 *  "persist this workspace's view of this module" reads better than
 *  "save module from documents". Returns the workspace with updated
 *  `documents` entries (new `text` + `loadedJson` for every file actually
 *  written) so the caller's next save sees the advanced state. */
export async function persistWorkspaceModule(
  workspace: Workspace,
  modulePath: string,
  adapter: WorkspaceAdapter,
): Promise<Workspace> {
  return saveModuleFromDocuments(workspace, modulePath, adapter);
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

  // Drop ModuleDocument entries that live under the deleted module's
  // directory. Covers the owner telo.yaml plus any partials colocated with
  // it. A future phase that persists importers via the AST can build on
  // this by only pruning keys we no longer own.
  const documents = new Map(workspace.documents);
  const dirPrefix = normalizePath(moduleDir) + "/";
  for (const key of [...documents.keys()]) {
    if (key === normalizePath(filePath) || key.startsWith(dirPrefix)) {
      documents.delete(key);
    }
  }

  // Drop imports in every importer that point at the deleted module —
  // prune both the ParsedManifest projection (for views) and the AST
  // (for the save path). Collect the importer paths here; the actual
  // disk writes happen after the new workspace is fully constructed so
  // `saveModuleFromDocuments` sees the final state.
  const importers = workspace.importedBy.get(filePath);
  const importersToSave: string[] = [];
  if (importers) {
    for (const importerPath of importers) {
      const importer = modules.get(importerPath);
      if (!importer) continue;

      const importsToRemove = importer.imports
        .filter((imp) => imp.resolvedPath === filePath)
        .map((imp) => imp.name);

      const importerKey = normalizePath(importerPath);
      const importerDoc = documents.get(importerKey);
      if (importerDoc) {
        let docs = importerDoc.docs;
        for (const name of importsToRemove) docs = removeImportDocument(docs, name);
        if (docs !== importerDoc.docs) {
          documents.set(importerKey, { ...importerDoc, docs });
        }
      }

      const updated = {
        ...importer,
        imports: importer.imports.filter((imp) => imp.resolvedPath !== filePath),
      };
      modules.set(importerPath, updated);
      importersToSave.push(importerPath);
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

  const resourceDocIndex = buildResourceDocIndex(modules, documents);
  let next: Workspace = {
    rootDir: workspace.rootDir,
    modules,
    importGraph,
    importedBy,
    documents,
    resourceDocIndex,
  };

  // Persist each importer via the AST path. Each save advances that file's
  // `loadedJson`, so threading the returned workspace forward keeps the
  // no-op-write guard accurate for subsequent operations.
  for (const importerPath of importersToSave) {
    try {
      next = await saveModuleFromDocuments(next, importerPath, adapter);
    } catch (err) {
      console.error(`Failed to persist updated importer ${importerPath}:`, err);
    }
  }

  return next;
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

