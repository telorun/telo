import type { ManifestAdapter } from "@telorun/analyzer";
import { DEFAULT_MANIFEST_FILENAME, Loader, RegistryAdapter } from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import type {
  AppSettings,
  Application,
  AvailableKind,
  ImportKind,
  ParsedImport,
  ParsedManifest,
  ParsedResource,
  RegistryServer,
} from "./model";

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
    // Compatibility path for older analyzer builds where Loader only accepts adapter arrays.
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

function pathExtname(p: string): string {
  const base = p.split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i);
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

// Returns the source string to store in Kernel.Import — relative path from
// fromPath's directory to toPath's directory (directory form, no extension).
export function toRelativeSource(fromPath: string, toPath: string): string {
  const fromDir = pathDirname(fromPath);
  const toDir = pathDirname(toPath);
  const rel = pathRelative(fromDir, toDir);
  return rel === "." ? "." : rel.startsWith(".") ? rel : "./" + rel;
}

// Reads a manifest file and returns the metadata.name from its Kernel.Module doc.
export async function readModuleMetadata(
  filePath: string,
  adapter: ManifestAdapter,
): Promise<string | null> {
  try {
    const loader = createEditorLoader(adapter, []);
    const docs = (await loader.loadModule(filePath)) as ResourceManifest[];
    const moduleDoc = docs.find((d) => d.kind === "Kernel.Module");
    return (moduleDoc?.metadata.name as string | undefined) ?? null;
  } catch {
    return null;
  }
}

// Adds a new import to a module in-memory and loads the submodule if local.
export async function addModuleImport(
  app: Application,
  fromPath: string,
  imp: ParsedImport,
  adapter: ManifestAdapter,
  extraAdapters: ManifestAdapter[] = [],
): Promise<Application> {
  const modules = new Map(app.modules);
  const importGraph = new Map(app.importGraph);
  const importedBy = new Map(app.importedBy);

  // Update the importing module's import list
  const fromModule = modules.get(fromPath)!;
  modules.set(fromPath, { ...fromModule, imports: [...fromModule.imports, imp] });

  const deps = new Set(importGraph.get(fromPath) ?? []);

  const resolvedPath = imp.resolvedPath ?? resolveDepPath(adapter, fromPath, imp.source);
  imp.resolvedPath = resolvedPath;

  deps.add(resolvedPath);
  importGraph.set(fromPath, deps);

  if (!importedBy.has(resolvedPath)) importedBy.set(resolvedPath, new Set());
  importedBy.get(resolvedPath)!.add(fromPath);

  if (!modules.has(resolvedPath)) {
    const loader = createEditorLoader(adapter, extraAdapters);
    const subGraph = await loader.loadModuleGraph(resolvedPath, (url, err) => {
      console.error(`Failed to load module ${url}:`, err);
    });
    // The sub-graph may key the root module under a different URL than
    // resolvedPath (e.g. registry adapter resolves to a full URL). Update
    // resolvedPath to match so getAvailableKinds can look it up.
    if (!subGraph.has(resolvedPath) && subGraph.size > 0) {
      const actualRoot = subGraph.keys().next().value as string;
      imp.resolvedPath = actualRoot;
      deps.delete(resolvedPath);
      deps.add(actualRoot);
      if (importedBy.has(resolvedPath)) {
        const parents = importedBy.get(resolvedPath)!;
        importedBy.delete(resolvedPath);
        importedBy.set(actualRoot, parents);
      }
    }
    for (const [filePath, docs] of subGraph) {
      if (modules.has(filePath)) continue;
      const parsed = buildParsedManifest(filePath, docs);
      modules.set(filePath, parsed);
      const subDeps = new Set<string>();
      importGraph.set(filePath, subDeps);
      for (const subImp of parsed.imports) {
        const depPath = resolveDepPath(adapter, filePath, subImp.source);
        subImp.resolvedPath = depPath;
        if (subGraph.has(depPath)) {
          subDeps.add(depPath);
          if (!importedBy.has(depPath)) importedBy.set(depPath, new Set());
          importedBy.get(depPath)!.add(filePath);
        }
      }
    }
  }

  return { rootPath: app.rootPath, modules, importGraph, importedBy };
}

// ---------------------------------------------------------------------------
// TauriAdapter — uses the read_file Rust command
// ---------------------------------------------------------------------------

class TauriAdapter implements ManifestAdapter {
  supports(url: string): boolean {
    return !url.startsWith("http") && !url.startsWith("pkg:");
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    const { invoke } = await import("@tauri-apps/api/core");
    const text = await invoke<string>("read_file", { path: url });
    return { text, source: url };
  }

  resolveRelative(base: string, relative: string): string {
    const resolved = pathResolve(base, relative);
    if (!pathExtname(resolved)) return resolved + "/" + DEFAULT_MANIFEST_FILENAME;
    return resolved;
  }
}

// ---------------------------------------------------------------------------
// WebFsAdapter — uses File System Access API (Chrome/Edge, localhost)
// ---------------------------------------------------------------------------

class WebFsAdapter implements ManifestAdapter {
  constructor(private readonly root: FileSystemDirectoryHandle) {}

  supports(url: string): boolean {
    return !url.startsWith("http") && !url.startsWith("pkg:");
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    const relPath = url.startsWith("/") ? url.slice(1) : url;
    const parts = relPath.split("/").filter(Boolean);
    let dir: FileSystemDirectoryHandle = this.root;
    for (const part of parts.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(part);
    }
    const fileHandle = await dir.getFileHandle(parts[parts.length - 1]);
    const file = await fileHandle.getFile();
    const text = await file.text();
    return { text, source: url };
  }

  resolveRelative(base: string, relative: string): string {
    const resolved = pathResolve(base, relative);
    if (!pathExtname(resolved)) return resolved + "/" + DEFAULT_MANIFEST_FILENAME;
    return resolved;
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

// ---------------------------------------------------------------------------
// SingleFileAdapter — fallback for browsers without File System Access API.
// Can only serve the one file that was opened; submodule imports fail silently.
// ---------------------------------------------------------------------------

class SingleFileAdapter implements ManifestAdapter {
  constructor(
    private readonly text: string,
    private readonly filePath: string,
  ) {}

  supports(url: string): boolean {
    return url === this.filePath;
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    return { text: this.text, source: url };
  }

  resolveRelative(_base: string, relative: string): string {
    return relative;
  }
}

// A no-op local adapter — supports nothing, used when only registry adapters are needed.
export const noopAdapter: ManifestAdapter = {
  supports: () => false,
  read: (url) => Promise.reject(new Error(`No adapter for: ${url}`)),
  resolveRelative: (_base, relative) => relative,
};

// ---------------------------------------------------------------------------
// File open
// ---------------------------------------------------------------------------

async function findRootManifest(dir: FileSystemDirectoryHandle): Promise<string | null> {
  const names: string[] = [];
  for await (const [name] of dir.entries()) {
    names.push(name as string);
  }
  return (
    names.find((n) => n === DEFAULT_MANIFEST_FILENAME) ??
    names.find((n) => n === "module.yaml") ??
    names.find((n) => n === "manifest.yaml") ??
    names.find((n) => n.endsWith(".yaml") || n.endsWith(".yml")) ??
    null
  );
}

function openFileViaInput(): Promise<{ text: string; name: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".yaml,.yml";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      resolve({ text: await file.text(), name: file.name });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function openRootManifest(): Promise<{
  adapter: ManifestAdapter;
  rootPath: string;
} | null> {
  if (isInTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({ filters: [{ name: "YAML", extensions: ["yaml", "yml"] }] });
    if (!result || typeof result !== "string") return null;
    return { adapter: new TauriAdapter(), rootPath: result };
  }

  if (supportsDirectoryPicker()) {
    // Chrome/Edge: full directory access — submodule imports work
    const dirHandle = await window.showDirectoryPicker();
    const rootFile = await findRootManifest(dirHandle);
    if (!rootFile) return null;
    return { adapter: new WebFsAdapter(dirHandle), rootPath: "/" + rootFile };
  }

  // Firefox/Safari fallback: single-file picker — submodule imports won't load
  const picked = await openFileViaInput();
  if (!picked) return null;
  const rootPath = "/" + picked.name;
  return { adapter: new SingleFileAdapter(picked.text, rootPath), rootPath };
}

// ---------------------------------------------------------------------------
// Manifest parsing helpers
// ---------------------------------------------------------------------------

const registryImportMatcher = new RegistryAdapter();

export function classifyImport(source: string): ImportKind {
  if (source.startsWith("pkg:") || /^https?:\/\//.test(source)) return "remote";
  if (isRegistryImportSource(source) && registryImportMatcher.supports(source)) return "external";
  return "submodule";
}

export function buildParsedManifest(filePath: string, docs: ResourceManifest[]): ParsedManifest {
  const moduleDoc = docs.find((r) => r.kind === "Kernel.Module");

  const imports: ParsedImport[] = docs
    .filter((r) => r.kind === "Kernel.Import")
    .map((r) => ({
      name: r.metadata.name as string,
      source: (r as Record<string, unknown>).source as string,
      importKind: classifyImport((r as Record<string, unknown>).source as string),
      variables: (r as Record<string, unknown>).variables as Record<string, unknown> | undefined,
      secrets: (r as Record<string, unknown>).secrets as Record<string, unknown> | undefined,
    }));

  const resources: ParsedResource[] = docs
    .filter((r) => r.kind !== "Kernel.Module" && r.kind !== "Kernel.Import")
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

  const targets: string[] =
    ((moduleDoc as Record<string, unknown> | undefined)?.targets as string[]) ?? [];

  const include = (moduleDoc as Record<string, unknown> | undefined)?.include as
    | string[]
    | undefined;

  const moduleMeta = moduleDoc as Record<string, unknown> | undefined;

  return {
    filePath,
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
    targets,
    imports,
    resources,
    ...(include?.length ? { include } : {}),
  };
}

// ---------------------------------------------------------------------------
// Application loader
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
 * Loads sub-graphs for any imports in the active module that aren't already in
 * the application's module map. Call this after replacing a manifest (e.g. from
 * source editing) to resolve newly-added or changed imports.
 */
export async function reconcileImports(
  app: Application,
  modulePath: string,
  adapter: ManifestAdapter,
  extraAdapters: ManifestAdapter[] = [],
): Promise<Application> {
  const manifest = app.modules.get(modulePath);
  if (!manifest) return app;

  const modules = new Map(app.modules);
  const importGraph = new Map(app.importGraph);
  const importedBy = new Map(app.importedBy);
  const deps = new Set(importGraph.get(modulePath) ?? []);

  const loader = createEditorLoader(adapter, extraAdapters);

  for (const imp of manifest.imports) {
    const resolvedPath = imp.resolvedPath ?? resolveDepPath(adapter, modulePath, imp.source);
    imp.resolvedPath = resolvedPath;
    deps.add(resolvedPath);

    if (!importedBy.has(resolvedPath)) importedBy.set(resolvedPath, new Set());
    importedBy.get(resolvedPath)!.add(modulePath);

    if (!modules.has(resolvedPath)) {
      try {
        const subGraph = await loader.loadModuleGraph(resolvedPath, (url, err) => {
          console.error(`Failed to load module ${url}:`, err);
        });
        if (!subGraph.has(resolvedPath) && subGraph.size > 0) {
          const actualRoot = subGraph.keys().next().value as string;
          imp.resolvedPath = actualRoot;
          deps.delete(resolvedPath);
          deps.add(actualRoot);
          if (importedBy.has(resolvedPath)) {
            const parents = importedBy.get(resolvedPath)!;
            importedBy.delete(resolvedPath);
            importedBy.set(actualRoot, parents);
          }
        }
        for (const [filePath, docs] of subGraph) {
          if (modules.has(filePath)) continue;
          const parsed = buildParsedManifest(filePath, docs);
          modules.set(filePath, parsed);
          const subDeps = new Set<string>();
          importGraph.set(filePath, subDeps);
          for (const subImp of parsed.imports) {
            const depPath = resolveDepPath(adapter, filePath, subImp.source);
            subImp.resolvedPath = depPath;
            if (subGraph.has(depPath)) {
              subDeps.add(depPath);
              if (!importedBy.has(depPath)) importedBy.set(depPath, new Set());
              importedBy.get(depPath)!.add(filePath);
            }
          }
        }
      } catch {
        // Import loading failed — leave it unresolved
      }
    }
  }

  importGraph.set(modulePath, deps);
  return { rootPath: app.rootPath, modules, importGraph, importedBy };
}

export async function loadApplication(
  rootPath: string,
  adapter: ManifestAdapter,
  extraAdapters: ManifestAdapter[] = [],
): Promise<Application> {
  const loader = createEditorLoader(adapter, extraAdapters);
  const moduleGraph = await loader.loadModuleGraph(rootPath, (url, err) => {
    console.error(`Failed to load module ${url}:`, err);
  });

  const modules = new Map<string, ParsedManifest>();
  const importGraph = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();

  for (const [filePath, docs] of moduleGraph) {
    const parsed = buildParsedManifest(filePath, docs);
    modules.set(filePath, parsed);
    const deps = new Set<string>();
    importGraph.set(filePath, deps);
    for (const imp of parsed.imports) {
      const depPath = resolveDepPath(adapter, filePath, imp.source);
      imp.resolvedPath = depPath;
      if (moduleGraph.has(depPath)) {
        deps.add(depPath);
        if (!importedBy.has(depPath)) importedBy.set(depPath, new Set());
        importedBy.get(depPath)!.add(filePath);
      }
    }
  }

  return { rootPath, modules, importGraph, importedBy };
}

// ---------------------------------------------------------------------------
// New application
// ---------------------------------------------------------------------------

export function getAvailableKinds(app: Application, manifest: ParsedManifest): AvailableKind[] {
  const result: AvailableKind[] = [];
  for (const imp of manifest.imports) {
    if (!imp.resolvedPath) continue;
    const mod = app.modules.get(imp.resolvedPath);
    if (!mod) continue;
    for (const r of mod.resources) {
      if (r.kind !== "Kernel.Definition") continue;
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

// The `new://` scheme marks an in-memory application that has not been saved.
export function createApplication(name: string): Application {
  const filePath = `new://${name}/${DEFAULT_MANIFEST_FILENAME}`;
  const manifest: ParsedManifest = {
    filePath,
    metadata: { name, version: "1.0.0" },
    targets: [],
    imports: [],
    resources: [],
  };
  return {
    rootPath: filePath,
    modules: new Map([[filePath, manifest]]),
    importGraph: new Map([[filePath, new Set()]]),
    importedBy: new Map(),
  };
}

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

/** Formats a multiline string as a YAML block scalar (|). */
function yamlBlockScalar(text: string, indent: number): string {
  const pad = " ".repeat(indent);
  const blockLines = text.split("\n");
  // Remove trailing empty line if present (block scalar trailing newline)
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
    kind: "Kernel.Module",
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
  if (manifest.targets.length > 0) moduleDoc.targets = manifest.targets;

  const importDocs = manifest.imports.map((imp) => ({
    kind: "Kernel.Import",
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


/** Produces per-file YAML snapshots for a multi-file module. Resources are written
 *  back to their originating sourceFile rather than collapsed into the owner. */
export function getMultiFileSnapshots(
  manifest: ParsedManifest,
): Array<{ filePath: string; yaml: string }> {
  // Group resources by sourceFile (or manifest.filePath if no sourceFile)
  const groups = new Map<string, ParsedResource[]>();
  for (const r of manifest.resources) {
    const file = r.sourceFile ?? manifest.filePath;
    let list = groups.get(file);
    if (!list) {
      list = [];
      groups.set(file, list);
    }
    list.push(r);
  }

  const snapshots: Array<{ filePath: string; yaml: string }> = [];

  // Owner file: module doc + imports + resources that belong to this file
  const ownerResources = groups.get(manifest.filePath) ?? [];
  const ownerManifest: ParsedManifest = { ...manifest, resources: ownerResources };
  const ownerDocs = toManifestDocs(ownerManifest);
  snapshots.push({
    filePath: manifest.filePath,
    yaml: ownerDocs.map((doc) => dumpYamlDoc(doc)).join("\n---\n"),
  });

  // Partial files: only their resources
  for (const [file, resources] of groups) {
    if (file === manifest.filePath) continue;
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
