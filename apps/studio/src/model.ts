import type { AstDocument, LoadedFile, Range } from "@telorun/analyzer";
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
  /** Which adapter type drives this runner: "http-runner" | "local-docker". */
  adapterId: string;
  /** The adapter's opaque config (baseUrl, …). */
  config: unknown;
  /** Seeded, non-removable runner (the local docker singleton). */
  builtIn?: boolean;
}

export interface AppSettings {
  registryServers: RegistryServer[];
  /** Base URL of the hub's static manifest cache used to resolve `oci://`
   *  imports (a browser can't speak the OCI protocol). Empty/undefined uses
   *  the public default (`manifests.telo.sh`); a self-hosted hub points this
   *  at its own bucket endpoint. */
  manifestCacheUrl?: string;
  /** Base URL of the telo hub used for import-source autocomplete (ref search
   *  + version lists). Empty/undefined uses the public default (`telo.sh`);
   *  a self-hosted hub points this at its own endpoint. */
  hubUrl?: string;
  /** Base URL the starter-template gallery loads from. It must serve a
   *  `templates.json` catalog and the referenced manifests over http(s) with
   *  CORS. Empty/undefined uses `DEFAULT_TEMPLATES_BASE_URL`. */
  templatesBaseUrl?: string;
  /** The user's runners. A run uses the one whose id is
   *  `activeRunnerId` (a single global selection). */
  runners: RunnerInstance[];
  activeRunnerId: string;
  /** Chosen topology view per candidate-set key (see `viewChoiceKey`). A
   *  preference rather than per-module state: answering "which of these views do
   *  I want" once per module would be a chore. */
  topologyViewByChoiceKey?: Record<string, string>;
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
  /** Effective category labels — the kind's own, else its module's. */
  categories: string[];
  /** The contract this kind implements, as `<owning module>.<Kind>`. Derived
   *  from `extends` by resolving its alias prefix inside the DECLARING library
   *  (whose aliases are private to it), so backends of one abstract share a key
   *  no matter which module each lives in. Absent when the kind extends
   *  nothing, or when the target can't be resolved (a `Telo.*` built-in). */
  contract?: string;
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
    /** Declared discovery categories — display labels an author writes
     *  (`[AI, Storage]`), used to filter the kind picker. A kind may override
     *  its module's. The hub derives match slugs from these; nothing in the
     *  editor does, since it only ever compares labels within one workspace. */
    categories?: string[];
  };
  imports: ParsedImport[];
  resources: ParsedResource[];
  include?: string[];
  /** `files:` glob patterns selecting non-manifest assets to ship alongside the
   *  module (e.g. an `Http.Static` `root:` directory). Expanded relative to the
   *  module directory when building a run bundle. */
  files?: string[];
  /** Env-bound `variables` / `secrets` blocks (flat, as they appear at the top
   *  level of the YAML doc). Shared by both module variants: Applications bind
   *  them from the host environment, Libraries declare them as the public
   *  contract importers must satisfy. */
  variables?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  /** A Library's public surface: the kinds importers may reference and the
   *  ready-made instances they may `!ref`. Read from the module doc so the
   *  editor can show and edit it — an Application has no `exports` block at
   *  all, which is what makes this the Library's counterpart to `targets`. */
  exports?: {
    kinds?: string[];
    resources?: string[];
    /** Left opaque: an `exports.code:` entry is delivery metadata (specifier,
     *  format, built path), not something the topology surface edits. */
    code?: unknown[];
  };
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

export type ImportKind = "local" | "registry" | "remote" | "oci";

export interface ParsedImport {
  name: string;
  source: string;
  importKind: ImportKind;
  resolvedPath?: string;
  /** The object form's `integrity:` sibling, when the entry wrote its pin there
   *  rather than as a `#sha256-…` fragment on `source`. Kept beside `source`
   *  instead of folded into it so the Imports view still displays the ref the
   *  author wrote; a consumer asking "is this pinned?" must check both. */
  integrity?: string;
  variables?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  /** True when this import lives in the module doc's inline `imports:` map
   *  rather than its own `Telo.Import` document. Determines where AST
   *  write-back (add/remove/upgrade) edits — the map entry vs. a separate doc. */
  inline?: boolean;
  /** Why loading this import's sub-graph into the workspace failed, when it
   *  did. Recorded rather than swallowed: the workspace still opens (one
   *  unreachable dependency must not block editing), but the Imports view says
   *  which import is unresolved and why, instead of leaving a row that silently
   *  resolves to nothing. Analysis reports the same failure on the import's own
   *  line — this is the workspace half of it, and the two agree because both
   *  come from the loader. */
  loadError?: string;
}

export interface ParsedResource {
  kind: string;
  name: string;
  module?: string;
  /** Own discovery categories, when the doc declares them. On a kind doc these
   *  replace (not extend) the module's — declaring them says where this kind
   *  belongs, which is the point when it sits outside its module's domain. */
  categories?: string[];
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
  /** True while external (registry/remote/library) dependency graphs are still
   *  being fetched in the background. The workspace renders immediately with
   *  only its local modules; imported-library kinds and full diagnostics stream
   *  in once enrichment completes and this clears. Analysis is held while true
   *  so transient "unresolved import" errors don't flash on first paint. */
  dependenciesPending?: boolean;
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

export type ViewId = "topology" | "outline" | "source" | "run";

/** An entry in the unified open-editors tab strip. A `module` tab hosts the
 *  structured `ViewContainer` (graph/outline/run/source) for a
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
}

/** Per-file record projected from `workspace.documents` for the active module.
 *  Owner file first, then partials in deterministic (alphabetical) order.
 *  `text` is the authoritative on-disk source text (pre-any-dirty edit);
 *  `parseError` is non-null when the file's AST couldn't be parsed cleanly. */
export interface ModuleSourceFile {
  filePath: string;
  text: string;
  /** Read-only per-document AST view, aligned to `text` — both come from the
   *  same parse, so a node's byte range indexes `text` exactly. Carried for the
   *  surfaces that show a SPAN of the source rather than the whole file (the
   *  detail panel's YAML pane slices one resource / one pointer out of it). */
  documents: AstDocument[];
  parseError?: string;
}

/** What an imported library declares that its importer must supply — its
 *  `variables:` / `secrets:` blocks, which for a Library are plain JSON-Schema
 *  declarations rather than env bindings. This is the CONTRACT, so it types the
 *  VALUES the importing module writes in that import's entry. */
export interface ImportedModuleConfig {
  variables?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
}

/** Stable data contract consumed by all editor views. */
export interface ModuleViewData {
  manifest: ParsedManifest;
  /** fullKind → merged local + imported kind metadata */
  kinds: Map<string, AvailableKind>;
  /** import alias → what that library declares its importer must supply.
   *  Resolved from the workspace here for the same reason `kinds` is: a view
   *  holds one module, and the answer lives in another one. */
  importedConfig: Map<string, ImportedModuleConfig>;
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
  /** Canvas viewport (pan/zoom), keyed by module filePath PLUS the view and the
   *  level it belongs to (`<module>#<viewId>#<viewKey>`). Two views lay a module
   *  out differently and a nesting view lays each level out independently, so a
   *  viewport restored across either would drop the user into empty space.
   *  In-memory only — not persisted across reloads. */
  viewportByModule: Record<string, CanvasViewport>;
  /** Per-module topology navigation: where the user is in the containment tree
   *  and each view's own state. In-memory, like `viewportByModule` — it records
   *  where you were, which is worth a tab switch and not worth restoring against
   *  a workspace that may have changed. */
  topologyByModule: Record<string, ModuleTopologyState>;
}

export interface ModuleTopologyState {
  /** Resource names below the containment root — the one navigation fact every
   *  topology view can interpret, and the only one: which canvas is on screen
   *  follows from the node this designates. */
  focusPath: string[];
  /** A resource another tab asked to navigate to, not yet resolved to a route.
   *  Only the topology host has the containment tree, so the name waits here
   *  until it can be turned into a `focusPath`. */
  focusRequest: string | null;
  /** Opaque per-view state, keyed by view id. The host persists it and never
   *  reads it, which is what keeps adding a view off the shared types. */
  viewState: Record<string, unknown>;
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
