import { DEFAULT_MANIFEST_FILENAME, HttpSource, flattenLoadedModule } from "@telorun/analyzer";
import type { ManifestSource } from "@telorun/analyzer";
import type { ImportKind, WorkspaceAdapter } from "../model";
import { moduleParseError, parseModuleDocument } from "../yaml-document";
import { LocalStorageAdapter } from "./adapters/local-storage";
import { buildParsedManifest } from "./parse";
import { createEditorLoader } from "./subgraph";
import { normalizePath, pathDirname, pathRelative } from "./paths";

// ---------------------------------------------------------------------------
// Remote manifest open — the "Open in Telo Editor" entry point.
//
// A link of the form `<editor>/?open=<url>` fetches a single manifest over
// HTTP and copies it into an in-browser virtual workspace under
// `/workspace/apps/<slug>/telo.yaml`, where it is edited purely locally. The
// manifest's imports resolve from that local copy (registry refs via the
// registry adapters); we deliberately copy only the one file, so relative
// imports surface as honest unresolved-import diagnostics.
// ---------------------------------------------------------------------------

/** Query-string key carrying the URL of the manifest to open. */
export const OPEN_PARAM = "open";

/** Root of the in-browser virtual workspace remote manifests are copied into. */
export const VIRTUAL_WORKSPACE_ROOT = "/workspace";

export interface RemoteManifest {
  /** The URL the manifest was fetched from. */
  url: string;
  /** Raw YAML text, written verbatim into the workspace. */
  text: string;
  /** `metadata.name` of the root Application/Library doc. */
  metadataName: string;
  /** Folder slug derived from `metadataName`. */
  slug: string;
  /** Destination path inside the virtual workspace. */
  destPath: string;
}

/** One file the import will write into the workspace (root or a same-origin
 *  relative dependency / include partial). */
export interface PlanFile {
  /** Canonical remote URL the content came from. */
  url: string;
  /** Destination path inside the virtual workspace. */
  destPath: string;
  /** Verbatim file text. */
  text: string;
  /** True for the root manifest (renamed to `telo.yaml`). */
  isRoot: boolean;
  /** True when a file already exists at `destPath` (will be overwritten). */
  exists: boolean;
}

/** The full set of changes a remote open will make, surfaced to the user for
 *  confirmation before anything is persisted. */
export interface RemoteImportPlan {
  rootUrl: string;
  name: string;
  kind: "Application" | "Library";
  description: string | null;
  /** The root module's declared imports (for preview). */
  imports: { name: string; source: string; importKind: ImportKind }[];
  rootDestPath: string;
  /** Every file that will be created/overwritten, root first. */
  files: PlanFile[];
  /** Same-origin cascade dependencies that failed to load — surfaced so the
   *  preview doesn't imply a complete import. */
  errors: { url: string; message: string }[];
}

/** Reads the manifest URL from a `location.search` string, or null when absent. */
export function readManifestUrlParam(search: string): string | null {
  const trimmed = new URLSearchParams(search).get(OPEN_PARAM)?.trim();
  return trimmed ? trimmed : null;
}

/** Strips the manifest param from the address bar so a reload doesn't re-import. */
export function clearManifestUrlParam(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete(OPEN_PARAM);
  window.history.replaceState(window.history.state, "", url.toString());
}

/** Derives a kebab-case folder name from a module's `metadata.name`
 *  (`HelloApiExample` → `hello-api-example`, `HTTPServer` → `http-server`). */
export function slugifyModuleName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/** Constructs the localStorage-backed virtual workspace adapter. */
export function createVirtualWorkspaceAdapter(): LocalStorageAdapter {
  return new LocalStorageAdapter(VIRTUAL_WORKSPACE_ROOT);
}

/** True when a file already exists at `destPath` in the workspace. */
export async function manifestExists(
  adapter: WorkspaceAdapter,
  destPath: string,
): Promise<boolean> {
  const slash = destPath.lastIndexOf("/");
  const dir = destPath.slice(0, slash);
  const filename = destPath.slice(slash + 1);
  const entries = await adapter.listDir(dir);
  return entries.some((e) => !e.isDirectory && e.name === filename);
}

/** Fetches a manifest over HTTP and resolves its destination in the virtual
 *  workspace. Throws with an actionable message on network failure, non-OK
 *  status, parse errors, or a missing Application/Library doc. */
export async function fetchRemoteManifest(url: string): Promise<RemoteManifest> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid manifest URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Unsupported manifest URL scheme "${parsed.protocol}" — only http and https links can be opened.`,
    );
  }

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not fetch manifest from ${url}: ${reason}. The host must allow cross-origin requests (CORS).`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Could not fetch manifest from ${url}: HTTP ${response.status} ${response.statusText}.`,
    );
  }

  const text = await response.text();
  const doc = parseModuleDocument(url, text);
  const parseError = moduleParseError(doc);
  if (parseError) {
    throw new Error(`Manifest at ${url} is not valid YAML: ${parseError}`);
  }

  const moduleDoc = doc.loaded.manifests.find(
    (m) => m?.kind === "Telo.Application" || m?.kind === "Telo.Library",
  );
  if (!moduleDoc) {
    throw new Error(
      `Manifest at ${url} has no Telo.Application or Telo.Library document — it cannot be opened in the editor.`,
    );
  }

  const name = moduleDoc.metadata?.name;
  if (typeof name !== "string" || !name.trim()) {
    throw new Error(`Manifest at ${url} is missing metadata.name.`);
  }

  const slug = slugifyModuleName(name);
  if (!slug) {
    throw new Error(
      `Could not derive a workspace folder from metadata.name "${name}" — it has no alphanumeric characters.`,
    );
  }

  const destPath = `${VIRTUAL_WORKSPACE_ROOT}/apps/${slug}/${DEFAULT_MANIFEST_FILENAME}`;
  return { url, text, metadataName: name, slug, destPath };
}

/** Maps a same-origin dependency's remote URL to a workspace path that mirrors
 *  its position relative to the root, so the same relative `source:` resolves
 *  locally exactly as it did remotely (both sides resolve against the importer
 *  directory and normalize). Throws if the result escapes the workspace. */
export function workspacePathFor(
  rootCanonicalUrl: string,
  rootDestPath: string,
  fileUrl: string,
): string {
  const rootDir = pathDirname(new URL(rootCanonicalUrl).pathname);
  const rel = pathRelative(rootDir, new URL(fileUrl).pathname);
  const local = normalizePath(`${pathDirname(rootDestPath)}/${rel}`);
  if (local !== VIRTUAL_WORKSPACE_ROOT && !local.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    throw new Error(
      `Dependency ${fileUrl} resolves outside the workspace and cannot be imported.`,
    );
  }
  return local;
}

/** Minimal shape of a loaded module needed to assemble plan files — kept
 *  structural so the assembly logic can be unit-tested without a live graph. */
interface PlanModule {
  owner: { source: string; text: string };
  partials: { source: string; text: string }[];
}

/** Assembles the verbatim files to persist from a loaded module graph: every
 *  same-origin module's owner plus its include partials, mapped to workspace
 *  paths that mirror their layout relative to the root. Cross-origin files
 *  (including any absolute-URL include partial of a same-origin module) are
 *  skipped. Root first, then alphabetical. */
export function collectPlanFiles(
  rootCanonical: string,
  rootDestPath: string,
  modules: Iterable<readonly [string, PlanModule]>,
): PlanFile[] {
  const rootOrigin = new URL(rootCanonical).origin;
  const byDest = new Map<string, PlanFile>();
  const addFile = (fileUrl: string, text: string, isRoot: boolean) => {
    if (!isRoot && new URL(fileUrl).origin !== rootOrigin) return;
    const destPath = isRoot ? rootDestPath : workspacePathFor(rootCanonical, rootDestPath, fileUrl);
    const existing = byDest.get(destPath);
    if (existing) {
      // Two distinct sources mapping to one workspace path (e.g. differing
      // query strings, same pathname) would persist non-deterministic content.
      if (existing.url !== fileUrl || existing.text !== text) {
        throw new Error(
          `Multiple remote files map to ${destPath} (${existing.url} vs ${fileUrl}) — cannot import safely.`,
        );
      }
      return;
    }
    byDest.set(destPath, { url: fileUrl, destPath, text, isRoot, exists: false });
  };
  for (const [canonical, lm] of modules) {
    if (new URL(canonical).origin !== rootOrigin) continue;
    const isRoot = canonical === rootCanonical;
    addFile(lm.owner.source, lm.owner.text, isRoot);
    for (const partial of lm.partials) addFile(partial.source, partial.text, false);
  }
  return [...byDest.values()].sort((a, b) =>
    a.isRoot === b.isRoot ? a.destPath.localeCompare(b.destPath) : a.isRoot ? -1 : 1,
  );
}

/** Resolves a remote manifest and its same-origin relative dependency graph
 *  into a concrete set of files to write. Uses the analyzer `loadGraph` +
 *  `HttpSource` for traversal and the editor's `buildParsedManifest` for
 *  preview metadata. Only same-origin files are persisted; registry imports
 *  resolve via the configured registry adapters and absolute cross-origin
 *  http(s) imports resolve live via the loader's built-in `HttpSource` — but
 *  neither is copied into the workspace. Same-origin dependencies that fail to
 *  load are surfaced in `plan.errors` (not silently dropped). */
export async function buildRemoteImportPlan(
  rootUrl: string,
  adapter: WorkspaceAdapter,
  registryAdapters: ManifestSource[] = [],
): Promise<RemoteImportPlan> {
  // Validates the URL scheme + that the root is an Application/Library, and
  // gives us the slug / root destination path.
  const root = await fetchRemoteManifest(rootUrl);

  const loader = createEditorLoader(new HttpSource(), registryAdapters);

  // Preview metadata comes from a plain (non-desugared) load so the root's
  // inline `imports:` map projects exactly once. Traversal uses a desugared
  // load so inline imports become real edges `loadGraph` can follow.
  const rootModule = await loader.loadModule(rootUrl);
  const rootParsed = buildParsedManifest(rootModule.owner.source, flattenLoadedModule(rootModule));

  const graph = await loader.loadGraph(rootUrl, { desugarImports: true });
  const rootOrigin = new URL(graph.rootSource).origin;
  const files = collectPlanFiles(graph.rootSource, root.destPath, graph.modules);
  await markExisting(adapter, files);

  // Surface same-origin load failures so the preview doesn't imply a complete
  // cascade. Cross-origin failures (e.g. an unconfigured registry) are expected
  // and resolved live, so they are not treated as cascade errors here.
  const errors = graph.errors
    .filter((e) => sameOrigin(e.url, rootOrigin))
    .map((e) => ({ url: e.url, message: e.error instanceof Error ? e.error.message : String(e.error) }));

  return {
    rootUrl,
    name: rootParsed.metadata.name,
    kind: rootParsed.kind,
    description: rootParsed.metadata.description ?? null,
    imports: rootParsed.imports.map((i) => ({
      name: i.name,
      source: i.source,
      importKind: i.importKind,
    })),
    rootDestPath: root.destPath,
    files,
    errors,
  };
}

/** True when `url` is an http(s) URL on `origin`; false for non-URL refs
 *  (e.g. registry shorthand) which can't be parsed as a URL. */
function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Marks `exists` on each plan file, batching one `listDir` per unique
 *  directory (the `LocalStorageAdapter` rescans all keys per call, so a
 *  per-file probe would be O(files × keys)). Directories are listed in
 *  parallel. */
async function markExisting(adapter: WorkspaceAdapter, files: PlanFile[]): Promise<void> {
  const dirs = [...new Set(files.map((f) => pathDirname(f.destPath)))];
  const present = new Map<string, Set<string>>();
  await Promise.all(
    dirs.map(async (dir) => {
      const entries = await adapter.listDir(dir);
      present.set(dir, new Set(entries.filter((e) => !e.isDirectory).map((e) => e.name)));
    }),
  );
  for (const f of files) {
    const dir = pathDirname(f.destPath);
    f.exists = present.get(dir)?.has(f.destPath.slice(dir.length + 1)) ?? false;
  }
}

/** Persists every file in a plan into the workspace, creating directories. */
export async function writeRemoteImportPlan(
  adapter: WorkspaceAdapter,
  plan: RemoteImportPlan,
): Promise<void> {
  for (const f of plan.files) {
    await adapter.createDir(pathDirname(f.destPath));
    await adapter.writeFile(f.destPath, f.text);
  }
}
