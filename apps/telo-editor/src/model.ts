import type { AnalysisDiagnostic } from "@telorun/analyzer";
import type { Document } from "yaml";

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

/** Per-file YAML AST record. Pairs each workspace file with its parsed
 *  multi-document AST and the exact source text read from or written to disk.
 *  The AST preserves comments, formatting, and arbitrary documents (including
 *  ones with no `kind` field); mutating the AST and re-serializing via the
 *  `yaml` library's `Document#toString()` is how the editor writes changes
 *  back without destroying user-authored content. */
export interface ModuleDocument {
  filePath: string;
  /** Exact source text last read from or written to disk. Used to bootstrap
   *  the source view without re-serializing and to recover the original text
   *  when a parse fails. */
  text: string;
  /** Multi-document AST. Empty when `parseError` is set. */
  docs: Document[];
  /** Semantic snapshot of `docs.map(d => d.toJSON())` at load time. Oracle
   *  for the no-op save guard: compared against the current AST's `.toJSON()`
   *  to decide whether to write on save. Does not include comments.
   *
   *  STABILITY ASSUMPTION: `toJSON()` output must be stable across `yaml`
   *  library versions for this guard to be correct. A library upgrade that
   *  changes scalar-type coercion or merge-key handling could cause
   *  `loadedJson` captured under the old version to diverge from a re-parse
   *  under the new version, triggering spurious reformats on first save. */
  loadedJson: unknown[];
  /** Non-null when parsing failed (syntax error, or any `Document` had
   *  non-empty `errors[]`). The entry is still created so the source view
   *  stays operable and the user can fix the file. */
  parseError?: string;
}

/** A workspace is a directory tree on disk containing one or more modules.
 *  `modules` holds every module reachable from the scan (workspace-local) or
 *  via transitive imports (registry/remote). `rootDir` distinguishes the two:
 *  workspace-local modules have a filePath under rootDir.
 *
 *  `documents` is the AST-layer source of truth for every workspace file
 *  (owner + included partials). Keys are canonicalized via `normalizePath`.
 *  `modules` is the analyzer-facing projection derived from `documents`;
 *  both are maintained in parallel — `modules` carries graph-derived data
 *  (`resolvedPath` for imports, resolved module names) that the AST alone
 *  cannot produce. */
export interface Workspace {
  rootDir: string;
  modules: Map<string, ParsedManifest>;
  importGraph: Map<string, Set<string>>;
  importedBy: Map<string, Set<string>>;
  /** Per-file AST state. Keyed by absolute file path, normalized via
   *  `normalizePath`. All lookups route the key through `normalizePath`
   *  first so kernel-stamped `metadata.source` values (which may contain
   *  `./`, `..`, or trailing slashes) resolve against the canonical key. */
  documents: Map<string, ModuleDocument>;
  /** Per-module side-table mapping `${kind}::${name}` → the document that
   *  contains the resource/import. Outer key is the owner module's
   *  canonicalized `filePath`; inner key scopes resource identity to a single
   *  module so `Http.Server/main` in module A and module B don't collide.
   *  Enables O(1) lookup from a canvas edit to the AST node to mutate.
   *  Rebuilt from scratch on every change to `documents`. */
  resourceDocIndex: Map<string, Map<string, { filePath: string; docIndex: number }>>;
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

/** Per-file record projected from `workspace.documents` for the active module.
 *  Owner file first, then partials in deterministic (alphabetical) order.
 *  `text` is the authoritative on-disk source text (pre-any-dirty edit);
 *  `parseError` is non-null when the file's AST couldn't be parsed cleanly. */
export interface ModuleSourceFile {
  filePath: string;
  text: string;
  parseError?: string;
}

/** Stable data contract consumed by all editor views. */
export interface ModuleViewData {
  manifest: ParsedManifest;
  /** fullKind → merged local + imported kind metadata */
  kinds: Map<string, AvailableKind>;
  /** resourceName → diagnostics (flat projection for the active module) */
  diagnostics: Map<string, AnalysisDiagnostic[]>;
  /** Per-file source text for every file the module spans (owner + partials).
   *  Populated from `workspace.documents`; consumed by the source view to
   *  seed its per-tab Monaco buffers. */
  sourceFiles: ModuleSourceFile[];
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
