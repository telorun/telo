import type { ManifestAdapter } from "@telorun/analyzer";
import { useEffect, useRef, useState } from "react";
import { analyzeWorkspace } from "../analysis";
import { useEditorPersistence } from "../hooks/useEditorPersistence";
import {
  addImportViaAst,
  classifyImport,
  createModule,
  createRegistryAdapters,
  createResourceViaAst,
  deleteModule,
  hasUnresolvedImports,
  isWorkspaceModule,
  loadWorkspace,
  noopAdapter,
  normalizePath,
  openWorkspaceDirectory,
  persistWorkspaceModule,
  rebuildManifestFromDocuments,
  reconcileImports,
  removeImportViaAst,
  reopenWorkspaceAt,
  setResourceFields,
  upgradeImportViaAst,
} from "../loader";
import type { ModuleDocument, ParsedManifest } from "../model";
import type {
  EditorState,
  ModuleKind,
  Selection,
  ViewId,
  Workspace,
  WorkspaceAdapter,
} from "../model";
import { DEFAULT_SETTINGS } from "../model";
import { readActiveEnvironment, setActiveEnvironmentEnv } from "../deployment";
import {
  buildRunBundle,
  registry as runRegistry,
  RunView,
  useRun,
} from "../run";
import {
  loadDeploymentsForWorkspace,
  saveDeploymentsForWorkspace,
} from "../storage-deployments";
import { buildModuleViewData } from "../view-data";
import { AppLifecyclePanel } from "./AppLifecyclePanel";
import { CreateResourceModal } from "./CreateResourceModal";
import { DetailPanel } from "./DetailPanel";
import { DiagnosticsProvider } from "./diagnostics/DiagnosticsContext";
import { getModuleFiles } from "../diagnostics-aggregate";
import { SettingsModal } from "./SettingsModal";
import { Sidebar } from "./sidebar/Sidebar";
import { TopBar } from "./TopBar";
import { ViewContainer } from "./views/ViewContainer";
import type { Range } from "@telorun/analyzer";

const INITIAL_STATE: EditorState = {
  workspace: null,
  activeModulePath: null,
  activeView: "topology",
  graphContext: null,
  selectedResource: null,
  panelStack: [],
  diagnostics: { byResource: new Map(), byFile: new Map() },
  sourceRevealRequest: null,
  deploymentsByApp: {},
};

/** Shallow, order-sensitive equality for `include:` lists. Used to detect
 *  source-edits that changed the owner module's partial-file set so Editor
 *  can trigger a full workspace reload — `rebuildManifestFromDocuments`
 *  alone doesn't re-run `include:` glob expansion. */
function includesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function pickInitialActiveModule(workspace: Workspace): string | null {
  const entries = [...workspace.modules.entries()].filter(([path]) =>
    isWorkspaceModule(workspace, path),
  );
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const app = entries.find(([, m]) => m.kind === "Application");
  if (app) return app[0];
  const lib = entries.find(([, m]) => m.kind === "Library");
  if (lib) return lib[0];
  return null;
}

export function Editor() {
  const { state, setState, settings, setSettings, persistedHint } = useEditorPersistence(
    INITIAL_STATE,
    DEFAULT_SETTINGS,
  );
  const runContext = useRun();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createResourceOpen, setCreateResourceOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);

  const manifestAdapterRef = useRef<ManifestAdapter | null>(null);
  const workspaceAdapterRef = useRef<WorkspaceAdapter | null>(null);
  const analysisTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRestoredRef = useRef(false);
  // "Latest ref" for handleRunModule — the recheck callback passed into
  // RunContext outlives the render that created it, so closing over the
  // function declaration directly captures a stale reference to state.
  const handleRunModuleRef = useRef<(filePath: string) => void | Promise<void>>(() => undefined);

  // Suppress Ctrl+S globally — save will be wired later
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Auto-restore the last workspace on mount, when the environment allows
  // re-attaching without a user gesture (Tauri filesystem, browser localStorage).
  // FSA can't silently re-attach — user sees the recent rootDir hint instead.
  useEffect(() => {
    if (autoRestoredRef.current) return;
    if (!persistedHint?.rootDir) return;
    if (state.workspace) return;
    autoRestoredRef.current = true;
    const reopened = reopenWorkspaceAt(persistedHint.rootDir);
    if (!reopened) return;
    let cancelled = false;
    (async () => {
      try {
        manifestAdapterRef.current = reopened.manifestAdapter;
        workspaceAdapterRef.current = reopened.workspaceAdapter;
        const workspace = await loadWorkspace(
          reopened.rootDir,
          reopened.manifestAdapter,
          reopened.workspaceAdapter,
          createRegistryAdapters(settings),
        );
        if (cancelled) return;
        const nextActiveModulePath =
          persistedHint.activeModulePath && workspace.modules.has(persistedHint.activeModulePath)
            ? persistedHint.activeModulePath
            : pickInitialActiveModule(workspace);
        const nextActiveModule = nextActiveModulePath
          ? workspace.modules.get(nextActiveModulePath)
          : null;
        // Deployment view only makes sense for Applications; if the persisted
        // view is "deployment" and the active module is a Library, fall back
        // to topology — same pattern storage.ts already uses for unknown views.
        const persistedView = persistedHint.activeView;
        const nextActiveView: ViewId =
          persistedView === "deployment" && nextActiveModule?.kind !== "Application"
            ? "topology"
            : (persistedView ?? "topology");
        setState((s) => ({
          ...s,
          workspace,
          activeModulePath: nextActiveModulePath,
          activeView: nextActiveView,
          deploymentsByApp: loadDeploymentsForWorkspace(reopened.rootDir),
        }));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [persistedHint, state.workspace, settings, setState]);

  // Debounced analysis: re-analyze whenever the workspace changes
  useEffect(() => {
    if (!state.workspace) return;
    if (analysisTimerRef.current) clearTimeout(analysisTimerRef.current);
    const workspace = state.workspace;
    analysisTimerRef.current = setTimeout(() => {
      const diagnostics = analyzeWorkspace(workspace);
      setState((s) => {
        if (s.workspace !== workspace) return s;
        return { ...s, diagnostics };
      });
    }, 300);
    return () => {
      if (analysisTimerRef.current) clearTimeout(analysisTimerRef.current);
    };
  }, [state.workspace]);

  // Persist deployment config on every mutation. Workspace-scoped, stored
  // under its own localStorage key (not via saveState).
  useEffect(() => {
    if (!state.workspace) return;
    saveDeploymentsForWorkspace(state.workspace.rootDir, state.deploymentsByApp);
  }, [state.workspace, state.deploymentsByApp]);

  const activeManifest =
    state.workspace && state.activeModulePath
      ? (state.workspace.modules.get(state.activeModulePath) ?? null)
      : null;

  // ---------------------------------------------------------------------------
  // Workspace lifecycle
  // ---------------------------------------------------------------------------

  async function handleOpen() {
    setError(null);
    setLoading(true);
    try {
      const opened = await openWorkspaceDirectory();
      if (!opened) return;
      manifestAdapterRef.current = opened.manifestAdapter;
      workspaceAdapterRef.current = opened.workspaceAdapter;
      const workspace = await loadWorkspace(
        opened.rootDir,
        opened.manifestAdapter,
        opened.workspaceAdapter,
        createRegistryAdapters(settings),
      );
      setState({
        ...INITIAL_STATE,
        workspace,
        activeModulePath: pickInitialActiveModule(workspace),
        deploymentsByApp: loadDeploymentsForWorkspace(opened.rootDir),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Module creation + deletion
  // ---------------------------------------------------------------------------

  async function handleCreateModule(kind: ModuleKind, relativePath: string, name: string) {
    const workspace = state.workspace;
    const adapter = workspaceAdapterRef.current;
    if (!workspace || !adapter) throw new Error("No workspace open");
    const updated = await createModule(workspace, { kind, relativePath, name }, adapter);
    const newFilePath = [...updated.modules.keys()].find((p) => !workspace.modules.has(p))!;
    setState((s) => ({
      ...s,
      workspace: updated,
      activeModulePath: newFilePath,
      graphContext: null,
      selectedResource: null,
      panelStack: [],
    }));
  }

  async function handleDeleteModule(filePath: string) {
    const workspace = state.workspace;
    const adapter = workspaceAdapterRef.current;
    if (!workspace || !adapter) return;
    const updated = await deleteModule(workspace, filePath, adapter);
    setState((s) => {
      const nextActive =
        s.activeModulePath === filePath
          ? pickInitialActiveModule(updated)
          : s.activeModulePath;
      return {
        ...s,
        workspace: updated,
        activeModulePath: nextActive,
        graphContext: nextActive === s.activeModulePath ? s.graphContext : null,
        selectedResource: nextActive === s.activeModulePath ? s.selectedResource : null,
        panelStack: nextActive === s.activeModulePath ? s.panelStack : [],
      };
    });
  }

  async function handleRunModule(filePath: string) {
    setError(null);
    if (!state.workspace) return;
    const workspace = state.workspace;
    const workspaceAdapter = workspaceAdapterRef.current;
    if (!workspaceAdapter) {
      setError("No workspace adapter available.");
      return;
    }

    const adapter = runRegistry.get(settings.activeRunAdapterId);
    if (!adapter) {
      // PR 5 will surface this as an inline message in the Run Settings row.
      setError(`Run adapter "${settings.activeRunAdapterId}" is not registered.`);
      setSettingsOpen(true);
      return;
    }

    const persistedConfig = settings.runAdapterConfig[adapter.id];
    const config = persistedConfig ?? adapter.defaultConfig;

    const syncIssues = adapter.validateConfig(config);
    if (syncIssues.length > 0) {
      // PR 5 wires these into the Run settings row; for now open Settings.
      setSettingsOpen(true);
      return;
    }

    let availability;
    try {
      availability = await adapter.isAvailable(config);
    } catch (err) {
      setError(
        `Failed to probe ${adapter.displayName}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (availability.status === "needs-setup") {
      setSettingsOpen(true);
      return;
    }
    if (availability.status === "unavailable") {
      runContext.showUnavailable({
        adapterId: adapter.id,
        adapterDisplayName: adapter.displayName,
        message: availability.message,
        remediation: availability.remediation,
        recheck: async () => {
          const again = await adapter.isAvailable(config);
          if (again.status === "ready") {
            runContext.closeRunView();
            void handleRunModuleRef.current(filePath);
          }
        },
      });
      return;
    }

    if (
      runContext.activeRun &&
      (runContext.activeRun.status.kind === "starting" ||
        runContext.activeRun.status.kind === "running")
    ) {
      const proceed = window.confirm("Stop current run and start new?");
      if (!proceed) return;
      await runContext.stopRun();
    }

    // save-before-run is a no-op today: every mutation in the editor persists
    // eagerly via `persistModule`. The only exception is the SourceView
    // Monaco debounce (~500ms); if the user clicks Run within that window the
    // unflushed edit runs one revision behind. Acceptable for v1; revisit if
    // it bites.

    // Read-only lookup — the seeded record is committed only on first user
    // edit via `setActiveEnvironmentEnv`. Running doesn't need to persist a
    // record just because the user ran it once with default env.
    const environment = readActiveEnvironment(state.deploymentsByApp, filePath);

    let bundle;
    try {
      bundle = await buildRunBundle(workspace, filePath, (p) =>
        workspaceAdapter.readFile(p),
      );
    } catch (err) {
      setError(
        `Failed to build run bundle: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    try {
      await runContext.startRun({
        adapter,
        config,
        request: { bundle, env: environment.env },
      });
    } catch (err) {
      setError(
        `Failed to start run: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Keep the ref pointed at the current handleRunModule. Safe during render
  // because refs are write-only here — no observed value flows back into the
  // render output.
  handleRunModuleRef.current = handleRunModule;

  /** Persists a single module to disk. Takes a prospective `workspace` so the
   *  AST-based save path can serialize from `workspace.documents.get(path).docs`
   *  directly; the legacy path reads the `ParsedManifest` from `workspace.modules`
   *  behind the scenes. Returns the workspace the caller should put in state —
   *  possibly enriched with updated `ModuleDocument.text` / `loadedJson` when
   *  the AST path wrote. Surfaces write failures via setError so the author
   *  notices before data diverges from the in-memory state. */
  async function persistModule(workspace: Workspace, filePath: string): Promise<Workspace> {
    const adapter = workspaceAdapterRef.current;
    if (!adapter) return workspace;
    try {
      return await persistWorkspaceModule(workspace, filePath, adapter);
    } catch (err) {
      setError(`Failed to save ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      return workspace;
    }
  }

  // ---------------------------------------------------------------------------
  // Import authoring
  // ---------------------------------------------------------------------------

  async function handleAddImport(source: string, alias: string) {
    if (!state.workspace || !state.activeModulePath) return;
    const imp = { name: alias, source, importKind: classifyImport(source) };
    const adapter = manifestAdapterRef.current ?? noopAdapter;
    const updated = await addImportViaAst(
      state.workspace,
      state.activeModulePath,
      imp,
      adapter,
      createRegistryAdapters(settings),
    );
    const persisted = await persistModule(updated, state.activeModulePath);
    setState((s) => ({ ...s, workspace: persisted }));
  }

  async function handleRemoveImport(name: string) {
    if (!state.workspace || !state.activeModulePath) return;
    const adapter = manifestAdapterRef.current ?? noopAdapter;
    const updated = await removeImportViaAst(
      state.workspace,
      state.activeModulePath,
      name,
      adapter,
      createRegistryAdapters(settings),
    );
    const persisted = await persistModule(updated, state.activeModulePath);
    setState((s) => ({ ...s, workspace: persisted }));
  }

  async function handleUpgradeImport(name: string, newSource: string) {
    if (!state.workspace || !state.activeModulePath) return;
    const adapter = manifestAdapterRef.current ?? noopAdapter;
    const updated = await upgradeImportViaAst(
      state.workspace,
      state.activeModulePath,
      name,
      newSource,
      adapter,
      createRegistryAdapters(settings),
    );
    const persisted = await persistModule(updated, state.activeModulePath);
    setState((s) => ({ ...s, workspace: persisted }));
  }

  // ---------------------------------------------------------------------------
  // Navigation (direct set, no stack)
  // ---------------------------------------------------------------------------

  function handleOpenModule(filePath: string) {
    runContext.closeRunView();
    setSelection(null);
    setState((s) => {
      const nextModule = s.workspace?.modules.get(filePath);
      // Leaving the Deployment view behind when switching to a Library —
      // the tab is hidden there so we pre-select a view that exists.
      const activeView: ViewId =
        s.activeView === "deployment" && nextModule?.kind !== "Application"
          ? "topology"
          : s.activeView;
      return {
        ...s,
        activeModulePath: filePath,
        activeView,
        graphContext: null,
        selectedResource: null,
        panelStack: [],
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Resource selection
  // ---------------------------------------------------------------------------

  function handleSelectResource(kind: string, name: string) {
    runContext.closeRunView();
    setSelection(null);
    setState((s) => ({
      ...s,
      selectedResource: { kind, name },
      panelStack: [{ type: "resource", kind, name }],
    }));
  }

  function handleClearSelection() {
    setSelection(null);
    setState((s) => ({ ...s, selectedResource: null, panelStack: [] }));
  }

  function handleNavigateResource(kind: string, name: string) {
    runContext.closeRunView();
    setSelection(null);
    setState((s) => ({
      ...s,
      activeView: "topology" as ViewId,
      graphContext: { kind, name },
      selectedResource: null,
      panelStack: [],
    }));
  }

  const revealNonceRef = useRef(0);
  function navigateToDiagnostic(filePath: string, range?: Range) {
    // UNKNOWN_FILE_KEY is not a real path — surfaced only in the future
    // Problems panel and never in resource-anchored UI. Guard here in case
    // a call site slips through.
    if (filePath === "__unknown__") return;
    const workspace = state.workspace;
    if (!workspace) return;
    const normalized = normalizePath(filePath);
    let ownerPath: string | null = null;
    for (const [modulePath, manifest] of workspace.modules) {
      if (getModuleFiles(manifest).includes(normalized)) {
        ownerPath = modulePath;
        break;
      }
    }
    if (!ownerPath) ownerPath = state.activeModulePath;
    revealNonceRef.current += 1;
    setState((s) => ({
      ...s,
      activeModulePath: ownerPath,
      activeView: "source" as ViewId,
      sourceRevealRequest: { filePath: normalized, range, nonce: revealNonceRef.current },
    }));
  }

  // ---------------------------------------------------------------------------
  // Resource creation
  // ---------------------------------------------------------------------------

  const viewData =
    state.workspace && activeManifest
      ? buildModuleViewData(state.workspace, activeManifest)
      : null;

  const availableKinds = viewData ? [...viewData.kinds.values()] : [];

  async function handleCreateResource(kind: string, name: string, fields: Record<string, unknown>) {
    if (!state.workspace || !state.activeModulePath) return;
    const updated = createResourceViaAst(
      state.workspace,
      state.activeModulePath,
      kind,
      name,
      fields,
    );
    const persisted = await persistModule(updated, state.activeModulePath);
    setState((s) => ({
      ...s,
      workspace: persisted,
      selectedResource: { kind, name },
      panelStack: [{ type: "resource", kind, name }],
    }));
    setSelection(null);
    setCreateResourceOpen(false);
  }

  function handleSelect(selection: Selection) {
    setSelection(selection);
    setState((s) => ({
      ...s,
      selectedResource: selection.resource,
      panelStack: [{ type: "resource", ...selection.resource }],
    }));
  }

  async function handleUpdateResource(kind: string, name: string, fields: Record<string, unknown>) {
    if (!state.workspace || !state.activeModulePath) return;
    const manifest = state.workspace.modules.get(state.activeModulePath);
    const prev = manifest?.resources.find((r) => r.kind === kind && r.name === name);
    if (!prev) return;
    const updated = setResourceFields(
      state.workspace,
      state.activeModulePath,
      kind,
      name,
      prev.fields,
      fields,
    );
    const persisted = await persistModule(updated, state.activeModulePath);
    setState((s) => ({ ...s, workspace: persisted }));
  }

  function handleSetDeploymentEnvVars(env: Record<string, string>) {
    const appPath = state.activeModulePath;
    if (!appPath) return;
    setState((s) => ({
      ...s,
      deploymentsByApp: setActiveEnvironmentEnv(s.deploymentsByApp, appPath, env),
    }));
  }

  /** Commits a source-view edit for one file in the active module. Replaces
   *  that file's `ModuleDocument` with a fresh parse, re-derives the
   *  ParsedManifest from the updated AST, reconciles imports whose source
   *  may have changed, and persists via the AST save path. Works for the
   *  module's owner file and any included partial file indistinguishably —
   *  per-file granularity matters because a partial's AST edit must land
   *  on the partial, not spill into the owner. */
  async function handleSourceEdit(filePath: string, moduleDoc: ModuleDocument) {
    if (!state.workspace || !state.activeModulePath) return;

    // All writes to `documents` go through the canonical `normalizePath`
    // key, matching every other mutation site. The `ModuleDocument.filePath`
    // field carries the display path for disk writes (adapter.writeFile),
    // but lookups only ever use the canonical key.
    const key = normalizePath(filePath);
    const documents = new Map(state.workspace.documents);
    // Preserve the previous `loadedJson` as the save baseline. A source-edit
    // produces a fresh `parseModuleDocument` whose `loadedJson` matches its
    // own `docs.map(toJSON)`, which would make `saveModuleFromDocuments`
    // see "no change" and skip the disk write — silently dropping the edit
    // on the next workspace reload.
    const prevDoc = state.workspace.documents.get(key);
    documents.set(key, {
      ...moduleDoc,
      loadedJson: prevDoc?.loadedJson ?? moduleDoc.loadedJson,
    });

    let workspace: Workspace = { ...state.workspace, documents };
    const prevInclude = state.workspace.modules.get(state.activeModulePath)?.include ?? [];
    workspace = rebuildManifestFromDocuments(workspace, state.activeModulePath);
    const nextInclude = workspace.modules.get(state.activeModulePath)?.include ?? [];

    const adapter = manifestAdapterRef.current ?? noopAdapter;
    if (hasUnresolvedImports(workspace, state.activeModulePath)) {
      workspace = await reconcileImports(
        workspace,
        state.activeModulePath,
        adapter,
        createRegistryAdapters(settings),
      );
    }

    workspace = await persistModule(workspace, state.activeModulePath);

    // `saveModuleFromDocuments` replaces `modDoc.text` with the re-serialized
    // output of `serializeModuleDocument`. For source edits the user's typed
    // text is authoritative — if the serializer reformats it (adds leading
    // `---`, normalizes whitespace, etc.), the SourceView's resync effect
    // would push the reformatted text into Monaco via `setValue`, which
    // jumps the cursor to the top. Restore the user's text so the buffer
    // stays stable; disk still holds the serialized form, and `loadedJson`
    // already reflects the persisted snapshot for future change detection.
    const persistedDoc = workspace.documents.get(key);
    if (persistedDoc && persistedDoc.text !== moduleDoc.text) {
      const patched = new Map(workspace.documents);
      patched.set(key, { ...persistedDoc, text: moduleDoc.text });
      workspace = { ...workspace, documents: patched };
    }

    // A source-edit that changed the owner's `include:` list can pull in
    // new partial files that `rebuildManifestFromDocuments` won't see —
    // that function uses existing `resources[].sourceFile` to discover
    // partials, not glob expansion. Reload the whole workspace so the
    // analyzer re-expands `include:` via the in-memory adapter and the
    // new partials get tracked in `workspace.documents`.
    if (!includesEqual(prevInclude, nextInclude)) {
      const workspaceAdapter = workspaceAdapterRef.current;
      if (workspaceAdapter) {
        try {
          workspace = await loadWorkspace(
            workspace.rootDir,
            adapter,
            workspaceAdapter,
            createRegistryAdapters(settings),
          );
        } catch (err) {
          console.error(`Failed to reload workspace after include change:`, err);
        }
      }
    }

    setState((s) => ({ ...s, workspace }));
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <DiagnosticsProvider
      navigate={navigateToDiagnostic}
      diagnostics={state.diagnostics}
      activeFilePaths={activeManifest ? getModuleFiles(activeManifest) : []}
    >
    <div className="flex h-screen flex-col overflow-hidden bg-white dark:bg-zinc-950">
      <TopBar
        workspace={state.workspace}
        activeManifest={activeManifest}
        onOpen={handleOpen}
        onOpenSettings={() => setSettingsOpen(true)}
        onRun={
          activeManifest?.kind === "Application"
            ? () => void handleRunModule(activeManifest.filePath)
            : undefined
        }
        runStatus={runContext.activeRun?.status ?? null}
        onOpenRunView={runContext.openRunView}
      />

      {error && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}
      {activeManifest?.loadError && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          <strong className="font-semibold">Module failed to parse.</strong> Edit the raw YAML in
          the Source tab to fix it. Error: {activeManifest.loadError}
        </div>
      )}
      {loading && (
        <div className="border-b border-blue-200 bg-blue-50 px-4 py-2 text-xs text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-400">
          Loading…
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          workspace={state.workspace}
          activeManifest={activeManifest}
          activeModulePath={state.activeModulePath}
          selectedResource={state.selectedResource}
          graphContext={state.graphContext}
          registryServers={settings.registryServers}
          viewData={viewData}
          onSelectResource={handleSelectResource}
          onNavigateResource={handleNavigateResource}
          onOpenModule={handleOpenModule}
          onCreateModule={handleCreateModule}
          onDeleteModule={handleDeleteModule}
          onRunModule={handleRunModule}
          onAddImport={handleAddImport}
          onRemoveImport={handleRemoveImport}
          onUpgradeImport={handleUpgradeImport}
          onCreateResource={() => setCreateResourceOpen(true)}
        />
        {runContext.isRunViewOpen ? (
          <RunView />
        ) : (
          <>
            {!state.workspace ? (
              <AppLifecyclePanel onOpen={handleOpen} recentRootDir={persistedHint?.rootDir} />
            ) : state.workspace.modules.size === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-zinc-50 px-6 text-center dark:bg-zinc-900">
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  This workspace is empty
                </p>
                <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-500">
                  Add your first module using the <strong>+</strong> next to Applications or
                  Libraries in the sidebar.
                </p>
              </div>
            ) : viewData ? (
              <ViewContainer
                activeView={state.activeView}
                onChangeView={(view) => setState((s) => ({ ...s, activeView: view }))}
                viewProps={{
                  viewData,
                  selectedResource: state.selectedResource,
                  graphContext: state.graphContext,
                  onSelectResource: handleSelectResource,
                  onNavigateResource: handleNavigateResource,
                  onUpdateResource: handleUpdateResource,
                  onSelect: handleSelect,
                  onClearSelection: handleClearSelection,
                  onSourceEdit: handleSourceEdit,
                  deployment: {
                    activeEnvironment: readActiveEnvironment(
                      state.deploymentsByApp,
                      state.activeModulePath,
                    ),
                    onSetEnvVars: handleSetDeploymentEnvVars,
                  },
                  revealRequest: state.sourceRevealRequest,
                }}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-zinc-400 dark:text-zinc-600">
                Select a module from the workspace tree.
              </div>
            )}
            <DetailPanel
              selectedResource={state.selectedResource}
              graphContext={state.graphContext}
              selection={selection}
              viewData={viewData}
              onUpdateResource={handleUpdateResource}
              onSelectResource={handleSelectResource}
              onSelect={handleSelect}
              onNavigateResource={handleNavigateResource}
            />
          </>
        )}
      </div>
      <SettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onChange={setSettings}
      />
      <CreateResourceModal
        open={createResourceOpen}
        onOpenChange={setCreateResourceOpen}
        kinds={availableKinds}
        onCreate={handleCreateResource}
      />
    </div>
    </DiagnosticsProvider>
  );
}
