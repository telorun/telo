import type { LoadedFile, Range } from "@telorun/analyzer";
import type { WorkspaceDiagnostics } from "./analysis";

export interface RegistryServer {
  id: string;
  url: string;
  label?: string;
  enabled: boolean;
}

/** A user-configured runner: an instance of an adapter *type* (`adapterId`)
 *  with that adapter's opaque config. The user manages a list of these (add /
 *  edit / remove / switch). */
export interface RunnerInstance {
  id: string;
  /** Display label. Captured from the runner's advertised `displayName` (or the
   *  adapter's generic name when the runner doesn't advertise one). */
  name: string;
  /** The runner's advertised description, shown under the name. */
  description?: string;
  /** Which adapter type drives this runner: "http-runner" | "tauri-docker". */
  adapterId: string;
  /** The adapter's opaque config (baseUrl, …). */
  config: unknown;
  /** Seeded, non-removable runner (the local docker singleton). */
  builtIn?: boolean;
}

export interface AppSettings {
  registryServers: RegistryServer[];
  /** The user's runners. The Run button uses the one whose id is
   *  `activeRunnerId` (a single global selection). */
  runners: RunnerInstance[];
  activeRunnerId: string;
}

export const TELO_CLOUD_RUNNER_ID = "telo-cloud";
export const LOCAL_DOCKER_RUNNER_ID = "local-docker";

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
  runners: [
    {
      id: TELO_CLOUD_RUNNER_ID,
      name: "Telo Cloud",
      adapterId: "http-runner",
      config: { baseUrl: "https://runner.telo.run" },
    },
  ],
  activeRunnerId: TELO_CLOUD_RUNNER_ID,
};

export type ModuleKind = "Application" | "Library";

/** Fields common to both module variants — identity, metadata, and the
 *  module body. Application-only fields live on `ApplicationManifest`. */
interface BaseParsedManifest {
  filePath: string;
  metadata: {
    name: string;
    version?: string;
    description?: string;
    namespace?: string;
  };
  imports: ParsedImport[];
  resources: ParsedResource[];
  include?: string[];
  /** Env-bound `variables` / `secrets` blocks (flat, as they appear at the top
   *  level of the YAML doc). Shared by both module variants: Applications bind
   *  them from the host environment, Libraries declare them as the public
   *  contract importers must satisfy. */
  variables?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  /** Populated only when the module could not be parsed. The editor still
   *  lists the module so the user can open its source and fix the issue;
   *  `rawYaml` is the unparsed text read from disk. */
  loadError?: string;
  rawYaml?: string;
}

/** A parsed `Telo.Application` — a runnable root. Carries the Application-only
 *  contract: `targets` plus the env-bound `variables` / `secrets` / `ports`
 *  blocks (flat, as they appear at the top level of the YAML doc). */
export interface ApplicationManifest extends BaseParsedManifest {
  kind: "Application";
  targets: string[];
  /** Declared inbound ports (`name → { env, protocol?, default? }`). */
  ports?: Record<string, unknown>;
}

/** A parsed `Telo.Library` — an importable unit of kinds/definitions. No
 *  `targets` (run-only) and no `ports` (Application-only). */
export interface LibraryManifest extends BaseParsedManifest {
  kind: "Library";
}

/** A parsed module, discriminated on `kind`. */
export type ParsedManifest = ApplicationManifest | LibraryManifest;

export type ImportKind = "local" | "registry" | "remote";

export interface ParsedImport {
  name: string;
  source: string;
  importKind: ImportKind;
  resolvedPath?: string;
  variables?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  /** True when this import lives in the module doc's inline `imports:` map
   *  rather than its own `Telo.Import` document. Determines where AST
   *  write-back (add/remove/upgrade) edits — the map entry vs. a separate doc. */
  inline?: boolean;
}

export interface ParsedResource {
  kind: string;
  name: string;
  module?: string;
  fields: Record<string, unknown>;
  sourceFile?: string;
}

/** Per-file YAML AST record. Pairs each workspace file with its parsed
 *  multi-document AST and the source text — both held inside a `LoadedFile`
 *  produced by `parseLoadedFile` / `Loader.loadFile`.
 *
 *  After an AST edit, the Documents inside `loaded.documents` are mutated
 *  in place; `loaded.text` / `loaded.manifests` / `loaded.positions` keep
 *  the load-time snapshot (the oracle for the no-op-save guard). On save
 *  the file is serialized and re-parsed, producing a fresh `loaded`. */
export interface ModuleDocument {
  filePath: string;
  /** Canonical parse result. Single source of truth for the AST, text,
   *  manifests, positions, and parse errors. */
  loaded: LoadedFile;
  /** True when the AST has been mutated since the last load/save and the
   *  on-disk text no longer matches the current document state. */
  dirty: boolean;
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

/** Mutation surface for a workspace. Read ops come from the ManifestSource
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
  /** Move/rename a file or directory. Creates the destination's parent
   *  directories if needed. Implemented natively per backend so directories
   *  and binary files move losslessly. */
  rename(from: string, to: string): Promise<void>;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export type ViewId =
  | "topology"
  | "imports"
  | "definitions"
  | "resources"
  | "kinds"
  | "source"
  | "deployment";

/** An entry in the unified open-editors tab strip. A `module` tab hosts the
 *  structured `ViewContainer` (topology/inventory/source/deployment) for a
 *  module owner file; a `file` tab hosts a raw Monaco editor for any other
 *  workspace file. `path` is the canonical file path and the tab's identity —
 *  a telo.yaml always opens as a module tab, never a file tab, so the path is
 *  an unambiguous key across both kinds. */
export type EditorTab =
  | { type: "module"; path: string }
  | { type: "file"; path: string };

/** Per-Application deployment configuration. Holds one or more named
 *  environments; v1 auto-creates a single `local` environment. Future work
 *  (multi-env, per-env adapter override, secrets refs) extends this shape
 *  without breaking v1 persisted state. Stored workspace-scoped in a
 *  separate localStorage key — see `storage-deployments.ts`. */
export interface ApplicationDeployment {
  activeEnvironmentId: string;
  environments: Record<string, DeploymentEnvironment>;
}

export interface PortMapping {
  port: number;
  protocol: "tcp" | "udp";
}

export interface DeploymentEnvironment {
  id: string;
  name: string;
  env: Record<string, string>;
  ports?: PortMapping[];
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
  /** Per-file source text for every file the module spans (owner + partials).
   *  Populated from `workspace.documents`; consumed by the source view to
   *  seed its per-tab Monaco buffers. */
  sourceFiles: ModuleSourceFile[];
}

export interface EditorState {
  workspace: Workspace | null;
  /** The module whose structured views and module-scoped sidebar sections
   *  (Imports/Definitions) are active. Tracks the active tab when it is a
   *  module tab; stays put (last module) while a file tab is focused. */
  activeModulePath: string | null;
  /** Open-editors tab strip. The single selection surface for the center pane:
   *  module tabs render `ViewContainer`, file tabs render the raw Monaco editor. */
  openTabs: EditorTab[];
  /** `path` of the active tab, or null when nothing is open. */
  activeTabId: string | null;
  /** Paths of expanded directories in the raw file explorer. Persisted so the
   *  tree restores its open/closed shape across reloads. */
  expandedDirs: string[];
  activeView: ViewId;
  /** The "canvas focus" resource in the active module — last resource the
   *  user navigated to in a topology/inventory view. Cleared when the active
   *  module changes. */
  graphContext: { kind: string; name: string } | null;
  selectedResource: { kind: string; name: string } | null;
  panelStack: PanelEntry[];
  diagnostics: WorkspaceDiagnostics;
  /** Transient request for SourceView to activate a tab and reveal a range.
   *  Written by `navigateToDiagnostic` in Editor; consumed by SourceView
   *  (keyed on `nonce` for idempotency across remounts). Never cleared — the
   *  view tracks its last-consumed nonce. */
  sourceRevealRequest: SourceRevealRequest | null;
  /** Per-Application deployment config, keyed by Application filePath.
   *  Hydrated from `storage-deployments.ts` on workspace load and persisted
   *  on every mutation. */
  deploymentsByApp: Record<string, ApplicationDeployment>;
  /** Per-module overview-canvas viewport (pan/zoom), keyed by module filePath,
   *  so the Application/Library graph restores its position when navigating back
   *  to it. In-memory only — not persisted across reloads. */
  viewportByModule: Record<string, CanvasViewport>;
}

/** Pan/zoom of the overview canvas — mirrors `@xyflow/react`'s `Viewport`. */
export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface SourceRevealRequest {
  filePath: string;
  range?: Range;
  /** Monotonically-increasing counter. Incrementing on repeat navigation to
   *  the same diagnostic is what re-fires the reveal effect even though the
   *  filePath+range are unchanged. */
  nonce: number;
}

export type PanelEntry =
  | { type: "resource"; kind: string; name: string }
  | { type: "item"; fieldPath: string[]; label: string };

export interface Selection {
  resource: { kind: string; name: string };
  /** JSON pointer into the resource fields, e.g. "/steps/0" or "/entries/2/handler" */
  pointer: string;
  schema: Record<string, unknown>;
  /** CEL evaluation mode for the rendered form — overrides the capability-based
   *  default. An edge's `inputs` selection sets `"runtime"` so every input field
   *  offers a CEL-expression toggle. */
  celEval?: "compile" | "runtime";
}
