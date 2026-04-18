import type { ManifestAdapter } from "@telorun/analyzer";
import { useEffect, useRef, useState } from "react";
import { analyzeWorkspace } from "../analysis";
import { useEditorPersistence } from "../hooks/useEditorPersistence";
import {
  addImport,
  classifyImport,
  createModule,
  createRegistryAdapters,
  deleteModule,
  isWorkspaceModule,
  loadWorkspace,
  noopAdapter,
  openWorkspaceDirectory,
  reconcileImports,
  reopenWorkspaceAt,
  saveModule,
} from "../loader";
import type { ParsedManifest } from "../model";
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
import { SettingsModal } from "./SettingsModal";
import { Sidebar } from "./sidebar/Sidebar";
import { TopBar } from "./TopBar";
import { ViewContainer } from "./views/ViewContainer";

const INITIAL_STATE: EditorState = {
  workspace: null,
  activeModulePath: null,
  activeView: "topology",
  graphContext: null,
  selectedResource: null,
  panelStack: [],
  diagnosticsByResource: new Map(),
  deploymentsByApp: {},
};

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
      const diagnosticsByResource = analyzeWorkspace(workspace);
      setState((s) => {
        if (s.workspace !== workspace) return s;
        return { ...s, diagnosticsByResource };
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
      bundle = await buildRunBundle(workspace, filePath, workspaceAdapter.readFile);
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

  /** Persists a single module to disk via the workspace adapter. Surfaces
   *  write failures as errors so the author notices before data diverges from
   *  the in-memory state. */
  async function persistModule(manifest: ParsedManifest): Promise<void> {
    const adapter = workspaceAdapterRef.current;
    if (!adapter) return;
    try {
      await saveModule(manifest, adapter);
    } catch (err) {
      setError(`Failed to save ${manifest.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Import authoring
  // ---------------------------------------------------------------------------

  async function handleAddImport(source: string, alias: string) {
    if (!state.workspace || !state.activeModulePath) return;
    const imp = { name: alias, source, importKind: classifyImport(source) };
    const adapter = manifestAdapterRef.current ?? noopAdapter;
    const updated = await addImport(
      state.workspace,
      state.activeModulePath,
      imp,
      adapter,
      createRegistryAdapters(settings),
    );
    const newManifest = updated.modules.get(state.activeModulePath);
    if (newManifest) await persistModule(newManifest);
    setState((s) => ({ ...s, workspace: updated }));
  }

  async function handleRemoveImport(name: string) {
    if (!state.workspace || !state.activeModulePath) return;
    const current = state.workspace.modules.get(state.activeModulePath);
    if (!current) return;
    const updated = {
      ...current,
      imports: current.imports.filter((i) => i.name !== name),
    };
    await persistModule(updated);
    setState((s) => {
      if (!s.workspace || !s.activeModulePath) return s;
      const modules = new Map(s.workspace.modules);
      modules.set(s.activeModulePath, updated);
      return { ...s, workspace: { ...s.workspace, modules } };
    });
  }

  async function handleUpgradeImport(name: string, newSource: string) {
    if (!state.workspace || !state.activeModulePath) return;

    const modules = new Map(state.workspace.modules);
    const current = modules.get(state.activeModulePath);
    if (!current) return;

    modules.set(state.activeModulePath, {
      ...current,
      imports: current.imports.filter((i) => i.name !== name),
    });
    const afterRemove: Workspace = { ...state.workspace, modules };

    const imp = { name, source: newSource, importKind: classifyImport(newSource) };
    const adapter = manifestAdapterRef.current ?? noopAdapter;
    const updated = await addImport(
      afterRemove,
      state.activeModulePath,
      imp,
      adapter,
      createRegistryAdapters(settings),
    );

    const newManifest = updated.modules.get(state.activeModulePath);
    if (newManifest) await persistModule(newManifest);

    setState((s) => ({ ...s, workspace: updated }));
  }

  // ---------------------------------------------------------------------------
  // Navigation (direct set, no stack)
  // ---------------------------------------------------------------------------

  function handleOpenModule(filePath: string) {
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
    setSelection(null);
    setState((s) => ({
      ...s,
      activeView: "topology" as ViewId,
      graphContext: { kind, name },
      selectedResource: null,
      panelStack: [],
    }));
  }

  // ---------------------------------------------------------------------------
  // Resource creation
  // ---------------------------------------------------------------------------

  const viewData =
    state.workspace && activeManifest
      ? buildModuleViewData(
          state.workspace,
          activeManifest,
          state.diagnosticsByResource.get(state.activeModulePath!),
        )
      : null;

  const availableKinds = viewData ? [...viewData.kinds.values()] : [];

  async function handleCreateResource(kind: string, name: string, fields: Record<string, unknown>) {
    if (!state.workspace || !state.activeModulePath) return;
    const current = state.workspace.modules.get(state.activeModulePath);
    if (!current) return;
    const updated = {
      ...current,
      resources: [...current.resources, { kind, name, fields }],
    };
    await persistModule(updated);
    setState((s) => {
      if (!s.workspace || !s.activeModulePath) return s;
      const modules = new Map(s.workspace.modules);
      modules.set(s.activeModulePath, updated);
      return {
        ...s,
        workspace: { ...s.workspace, modules },
        selectedResource: { kind, name },
        panelStack: [{ type: "resource", kind, name }],
      };
    });
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
    const current = state.workspace.modules.get(state.activeModulePath);
    if (!current) return;

    const updated = {
      ...current,
      resources: current.resources.map((resource) =>
        resource.kind === kind && resource.name === name ? { ...resource, fields } : resource,
      ),
    };
    await persistModule(updated);
    setState((s) => {
      if (!s.workspace || !s.activeModulePath) return s;
      const modules = new Map(s.workspace.modules);
      modules.set(s.activeModulePath, updated);
      return { ...s, workspace: { ...s.workspace, modules } };
    });
  }

  function handleSetDeploymentEnvVars(env: Record<string, string>) {
    const appPath = state.activeModulePath;
    if (!appPath) return;
    setState((s) => ({
      ...s,
      deploymentsByApp: setActiveEnvironmentEnv(s.deploymentsByApp, appPath, env),
    }));
  }

  async function handleReplaceManifest(manifest: typeof activeManifest & {}) {
    if (!state.workspace || !state.activeModulePath) return;

    await persistModule(manifest);

    const modules = new Map(state.workspace.modules);
    modules.set(state.activeModulePath, manifest);
    let workspace: Workspace = { ...state.workspace, modules };

    const adapter = manifestAdapterRef.current ?? noopAdapter;
    workspace = await reconcileImports(
      workspace,
      state.activeModulePath,
      adapter,
      createRegistryAdapters(settings),
    );

    setState((s) => ({ ...s, workspace }));
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
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
                  onReplaceManifest: handleReplaceManifest,
                  deployment: {
                    activeEnvironment: readActiveEnvironment(
                      state.deploymentsByApp,
                      state.activeModulePath,
                    ),
                    onSetEnvVars: handleSetDeploymentEnvVars,
                  },
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
  );
}
