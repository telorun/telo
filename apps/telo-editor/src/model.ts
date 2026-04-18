import type { AnalysisDiagnostic } from "@telorun/analyzer";

export interface RegistryServer {
  id: string;
  url: string;
  label?: string;
  enabled: boolean;
}

export interface AppSettings {
  registryServers: RegistryServer[];
  /** Id of the run adapter the Run button uses. Each adapter's opaque config
   *  lives under `runAdapterConfig[id]`; adapters resolve a fallback to their
   *  `defaultConfig` when the key is missing, so partial-migration of older
   *  persisted settings is safe. */
  activeRunAdapterId: string;
  runAdapterConfig: Record<string, unknown>;
}

export interface AvailableKind {
  fullKind: string;
  alias: string;
  kindName: string;
  capability: string;
  topology?: string;
  schema: Record<string, unknown>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  registryServers: [
    { id: "default", url: "https://registry.telo.run", label: "Official Registry", enabled: true },
  ],
  activeRunAdapterId: "tauri-docker",
  runAdapterConfig: {},
};

export type ModuleKind = "Application" | "Library";

export interface ParsedManifest {
  filePath: string;
  kind: ModuleKind;
  metadata: {
    name: string;
    version?: string;
    description?: string;
    namespace?: string;
    variables?: Record<string, unknown>;
    secrets?: Record<string, unknown>;
  };
  targets: string[];
  imports: ParsedImport[];
  resources: ParsedResource[];
  include?: string[];
  /** Populated only when the module could not be parsed. The editor still
   *  lists the module so the user can open its source and fix the issue;
   *  `rawYaml` is the unparsed text read from disk. */
  loadError?: string;
  rawYaml?: string;
}

export type ImportKind = "local" | "registry" | "remote";

export interface ParsedImport {
  name: string;
  source: string;
  importKind: ImportKind;
  resolvedPath?: string;
  variables?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
}

export interface ParsedResource {
  kind: string;
  name: string;
  module?: string;
  fields: Record<string, unknown>;
  sourceFile?: string;
}

/** A workspace is a directory tree on disk containing one or more modules.
 *  `modules` holds every module reachable from the scan (workspace-local) or
 *  via transitive imports (registry/remote). `rootDir` distinguishes the two:
 *  workspace-local modules have a filePath under rootDir. */
export interface Workspace {
  rootDir: string;
  modules: Map<string, ParsedManifest>;
  importGraph: Map<string, Set<string>>;
  importedBy: Map<string, Set<string>>;
}

/** Mutation surface for a workspace. Read ops come from the ManifestAdapter
 *  (shared with the runtime); WorkspaceAdapter adds the write/list/delete
 *  ops the editor needs. Kept split so analyzer code never sees mutations. */
export interface WorkspaceAdapter {
  /** Read text file. Relative to the workspace root (or absolute, implementation-defined). */
  readFile(path: string): Promise<string>;
  /** Write text file; creates parent directories if needed. */
  writeFile(path: string, text: string): Promise<void>;
  /** List directory entries (one level). */
  listDir(path: string): Promise<DirEntry[]>;
  /** Create directory (recursive). */
  createDir(path: string): Promise<void>;
  /** Delete a file or directory (recursive for directories). */
  delete(path: string): Promise<void>;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export type ViewId = "topology" | "inventory" | "source" | "deployment";

/** Per-Application deployment configuration. Holds one or more named
 *  environments; v1 auto-creates a single `local` environment. Future work
 *  (multi-env, per-env adapter override, secrets refs) extends this shape
 *  without breaking v1 persisted state. Stored workspace-scoped in a
 *  separate localStorage key — see `storage-deployments.ts`. */
export interface ApplicationDeployment {
  activeEnvironmentId: string;
  environments: Record<string, DeploymentEnvironment>;
}

export interface DeploymentEnvironment {
  id: string;
  name: string;
  env: Record<string, string>;
}

/** Stable data contract consumed by all editor views. */
export interface ModuleViewData {
  manifest: ParsedManifest;
  /** fullKind → merged local + imported kind metadata */
  kinds: Map<string, AvailableKind>;
  /** resourceName → diagnostics (flat projection for the active module) */
  diagnostics: Map<string, AnalysisDiagnostic[]>;
}

export interface EditorState {
  workspace: Workspace | null;
  activeModulePath: string | null;
  activeView: ViewId;
  /** The "canvas focus" resource in the active module — last resource the
   *  user navigated to in a topology/inventory view. Cleared when the active
   *  module changes. */
  graphContext: { kind: string; name: string } | null;
  selectedResource: { kind: string; name: string } | null;
  panelStack: PanelEntry[];
  diagnosticsByResource: Map<string, Map<string, AnalysisDiagnostic[]>>;
  /** Per-Application deployment config, keyed by Application filePath.
   *  Hydrated from `storage-deployments.ts` on workspace load and persisted
   *  on every mutation. */
  deploymentsByApp: Record<string, ApplicationDeployment>;
}

export type PanelEntry =
  | { type: "resource"; kind: string; name: string }
  | { type: "item"; fieldPath: string[]; label: string };

export interface Selection {
  resource: { kind: string; name: string };
  /** JSON pointer into the resource fields, e.g. "/steps/0" or "/entries/2/handler" */
  pointer: string;
  schema: Record<string, unknown>;
}
