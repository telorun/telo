import type { ManifestAdapter } from "@telorun/analyzer";
import { useEffect, useRef, useState } from "react";
import { analyzeApplication } from "../analysis";
import { useEditorPersistence } from "../hooks/useEditorPersistence";
import {
  addModuleImport,
  classifyImport,
  createApplication,
  createRegistryAdapters,
  isInTauri,
  loadApplication,
  noopAdapter,
  openRootManifest,
  readModuleMetadata,
  toPascalCase,
  toRelativeSource,
} from "../loader";
import type {
  Application,
  EditorState,
  Selection,
  NavigationEntry,
  ViewId,
} from "../model";
import { DEFAULT_SETTINGS } from "../model";
import { buildModuleViewData } from "../view-data";
import { AppLifecyclePanel } from "./AppLifecyclePanel";
import { CreateResourceModal } from "./CreateResourceModal";
import { DetailPanel } from "./DetailPanel";
import { SettingsModal } from "./SettingsModal";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { ViewContainer } from "./views/ViewContainer";

const INITIAL_STATE: EditorState = {
  application: null,
  activeModulePath: null,
  activeView: "topology",
  navigationStack: [],
  selectedResource: null,
  panelStack: [],
  diagnosticsByResource: new Map(),
};

function pruneUnreachableModules(application: Application): Application {
  const reachable = new Set<string>();
  const queue: string[] = [application.rootPath];

  while (queue.length > 0) {
    const path = queue.shift();
    if (!path || reachable.has(path)) continue;
    const manifest = application.modules.get(path);
    if (!manifest) continue;

    reachable.add(path);
    for (const imp of manifest.imports) {
      const depPath = imp.resolvedPath ?? imp.source;
      if (application.modules.has(depPath) && !reachable.has(depPath)) {
        queue.push(depPath);
      }
    }
  }

  const modules = new Map<
    string,
    Application["modules"] extends Map<string, infer V> ? V : never
  >();
  const importGraph = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();

  for (const [filePath, manifest] of application.modules) {
    if (!reachable.has(filePath)) continue;
    modules.set(filePath, manifest);
  }

  for (const [filePath, manifest] of modules) {
    const deps = new Set<string>();
    importGraph.set(filePath, deps);

    for (const imp of manifest.imports) {
      const depPath = imp.resolvedPath ?? imp.source;
      if (!modules.has(depPath)) continue;
      deps.add(depPath);

      if (!importedBy.has(depPath)) importedBy.set(depPath, new Set());
      importedBy.get(depPath)!.add(filePath);
    }
  }

  return {
    rootPath: application.rootPath,
    modules,
    importGraph,
    importedBy,
  };
}

function sanitizeNavigationStack(
  stack: NavigationEntry[],
  modules: Map<string, unknown>,
  rootPath: string,
): NavigationEntry[] {
  const filtered = stack.filter((entry) => entry.type !== "module" || modules.has(entry.filePath));
  if (filtered.length > 0) return filtered;
  return [{ type: "module", filePath: rootPath, graphContext: null }];
}

export function Editor() {
  const { state, setState, settings, setSettings } = useEditorPersistence(
    INITIAL_STATE,
    DEFAULT_SETTINGS,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createResourceOpen, setCreateResourceOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);

  const adapterRef = useRef<ManifestAdapter | null>(null);
  const analysisTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced analysis: re-analyze whenever the application changes
  useEffect(() => {
    if (!state.application) return;
    if (analysisTimerRef.current) clearTimeout(analysisTimerRef.current);
    const app = state.application;
    analysisTimerRef.current = setTimeout(() => {
      const diagnosticsByResource = analyzeApplication(app);
      setState((s) => {
        // Only update if the application hasn't changed since we started
        if (s.application !== app) return s;
        return { ...s, diagnosticsByResource };
      });
    }, 300);
    return () => {
      if (analysisTimerRef.current) clearTimeout(analysisTimerRef.current);
    };
  }, [state.application]);

  const activeManifest =
    state.application && state.activeModulePath
      ? (state.application.modules.get(state.activeModulePath) ?? null)
      : null;
  const currentNavigationEntry = state.navigationStack.at(-1) ?? null;
  const graphContext =
    currentNavigationEntry?.type === "module" ? currentNavigationEntry.graphContext : null;

  // ---------------------------------------------------------------------------
  // Application lifecycle
  // ---------------------------------------------------------------------------

  function handleCreate(name: string) {
    adapterRef.current = null;
    const application = createApplication(name);
    setCreating(false);
    setState({
      ...INITIAL_STATE,
      application,
      activeModulePath: application.rootPath,
      navigationStack: [{ type: "module", filePath: application.rootPath, graphContext: null }],
    });
  }

  async function handleOpen() {
    setError(null);
    setLoading(true);
    try {
      const opened = await openRootManifest();
      if (!opened) return;
      adapterRef.current = opened.adapter;
      const application = await loadApplication(
        opened.rootPath,
        opened.adapter,
        createRegistryAdapters(settings),
      );
      setState({
        ...INITIAL_STATE,
        application,
        activeModulePath: opened.rootPath,
        navigationStack: [{ type: "module", filePath: opened.rootPath, graphContext: null }],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Import authoring
  // ---------------------------------------------------------------------------

  async function handleBrowseForModule(): Promise<{
    source: string;
    suggestedAlias: string;
  } | null> {
    const adapter = adapterRef.current;
    if (!isInTauri() || !state.activeModulePath || !adapter) return null;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({ filters: [{ name: "YAML", extensions: ["yaml", "yml"] }] });
    if (!result || typeof result !== "string") return null;
    const name = await readModuleMetadata(result, adapter);
    const source = toRelativeSource(state.activeModulePath, result);
    const suggestedAlias = toPascalCase(name ?? result.split("/").at(-2) ?? "Module");
    return { source, suggestedAlias };
  }

  async function handleAddModule(source: string, alias: string) {
    const adapter = adapterRef.current;
    if (!state.application || !state.activeModulePath || !adapter) return;
    const resolvedPath = adapter.resolveRelative(state.activeModulePath, source);
    const imp = { name: alias, source, importKind: "submodule" as const, resolvedPath };
    const updated = await addModuleImport(
      state.application,
      state.activeModulePath,
      imp,
      adapter,
      createRegistryAdapters(settings),
    );
    setState((s) => ({ ...s, application: updated }));
  }

  async function handleAddImport(source: string, alias: string) {
    if (!state.application || !state.activeModulePath) return;
    const imp = { name: alias, source, importKind: classifyImport(source) };
    const adapter = adapterRef.current ?? noopAdapter;
    const updated = await addModuleImport(
      state.application,
      state.activeModulePath,
      imp,
      adapter,
      createRegistryAdapters(settings),
    );
    setState((s) => ({ ...s, application: updated }));
  }

  function handleRemoveImport(name: string) {
    if (!state.application || !state.activeModulePath) return;
    setState((s) => {
      if (!s.application || !s.activeModulePath) return s;

      const modules = new Map(s.application.modules);
      const current = modules.get(s.activeModulePath);
      if (!current) return s;

      modules.set(s.activeModulePath, {
        ...current,
        imports: current.imports.filter((i) => i.name !== name),
      });

      const pruned = pruneUnreachableModules({ ...s.application, modules });
      const navigationStack = sanitizeNavigationStack(
        s.navigationStack,
        pruned.modules as Map<string, unknown>,
        pruned.rootPath,
      );
      const activeModulePath = pruned.modules.has(s.activeModulePath)
        ? s.activeModulePath
        : pruned.rootPath;
      const shouldResetSelection = activeModulePath !== s.activeModulePath;

      return {
        ...s,
        application: pruned,
        navigationStack,
        activeModulePath,
        selectedResource: shouldResetSelection ? null : s.selectedResource,
        panelStack: shouldResetSelection ? [] : s.panelStack,
      };
    });
  }

  async function handleUpgradeImport(name: string, newSource: string) {
    if (!state.application || !state.activeModulePath) return;

    const modules = new Map(state.application.modules);
    const current = modules.get(state.activeModulePath);
    if (!current) return;

    // Remove old import and prune its graph
    modules.set(state.activeModulePath, {
      ...current,
      imports: current.imports.filter((i) => i.name !== name),
    });
    const pruned = pruneUnreachableModules({ ...state.application, modules });

    // Re-add with new source to re-resolve the graph
    const imp = { name, source: newSource, importKind: classifyImport(newSource) };
    const adapter = adapterRef.current ?? noopAdapter;
    const updated = await addModuleImport(
      pruned,
      state.activeModulePath,
      imp,
      adapter,
      createRegistryAdapters(settings),
    );

    setState((s) => {
      const navigationStack = sanitizeNavigationStack(
        s.navigationStack,
        updated.modules as Map<string, unknown>,
        updated.rootPath,
      );
      return { ...s, application: updated, navigationStack };
    });
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  function handleOpenModule(filePath: string) {
    setSelection(null);
    setState((s) => ({
      ...s,
      activeModulePath: filePath,
      selectedResource: null,
      panelStack: [],
      navigationStack: [...s.navigationStack, { type: "module", filePath, graphContext: null }],
    }));
  }

  function handlePopTo(index: number) {
    setSelection(null);
    setState((s) => {
      const entry = s.navigationStack[index];
      if (!entry || entry.type !== "module") return s;
      const newStack = s.navigationStack.slice(0, index + 1);
      return {
        ...s,
        navigationStack: newStack,
        activeModulePath: entry.filePath,
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
    setState((s) => {
      const nextStack = [...s.navigationStack];
      const current = nextStack.at(-1);
      if (!current || current.type !== "module") return s;

      nextStack[nextStack.length - 1] = {
        ...current,
        graphContext: { kind, name },
      };

      return {
        ...s,
        activeView: "topology" as ViewId,
        navigationStack: nextStack,
        selectedResource: { kind, name },
        panelStack: [{ type: "resource", kind, name }],
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Resource creation
  // ---------------------------------------------------------------------------

  // Stable view data contract — consumed by all views
  const viewData =
    state.application && activeManifest
      ? buildModuleViewData(
          state.application,
          activeManifest,
          state.diagnosticsByResource.get(state.activeModulePath!),
        )
      : null;

  const availableKinds = viewData ? [...viewData.kinds.values()] : [];


  function handleCreateResource(kind: string, name: string, fields: Record<string, unknown>) {
    if (!state.application || !state.activeModulePath) return;
    const modules = new Map(state.application.modules);
    const current = modules.get(state.activeModulePath)!;
    const newResource = { kind, name, fields };
    modules.set(state.activeModulePath, {
      ...current,
      resources: [...current.resources, newResource],
    });
    setState((s) => ({
      ...s,
      application: { ...s.application!, modules },
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

  function handleUpdateResource(kind: string, name: string, fields: Record<string, unknown>) {
    if (!state.application || !state.activeModulePath) return;
    const modules = new Map(state.application.modules);
    const current = modules.get(state.activeModulePath);
    if (!current) return;

    modules.set(state.activeModulePath, {
      ...current,
      resources: current.resources.map((resource) =>
        resource.kind === kind && resource.name === name ? { ...resource, fields } : resource,
      ),
    });

    setState((s) => ({ ...s, application: { ...s.application!, modules } }));
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-white dark:bg-zinc-950">
      <TopBar
        application={state.application}
        navigationStack={state.navigationStack}
        onNew={() => setCreating(true)}
        onOpen={handleOpen}
        onPopTo={handlePopTo}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {error && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}
      {loading && (
        <div className="border-b border-blue-200 bg-blue-50 px-4 py-2 text-xs text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-400">
          Loading…
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          activeManifest={activeManifest}
          selectedResource={state.selectedResource}
          graphContext={graphContext}
          registryServers={settings.registryServers}
          viewData={viewData}
          onSelectResource={handleSelectResource}
          onNavigateResource={handleNavigateResource}
          onOpenModule={handleOpenModule}
          onPickModuleFile={isInTauri() && adapterRef.current ? handleBrowseForModule : null}
          onAddModule={handleAddModule}
          onAddImport={handleAddImport}
          onRemoveImport={handleRemoveImport}
          onUpgradeImport={handleUpgradeImport}
          onCreateResource={() => setCreateResourceOpen(true)}
        />
        {!state.application || creating ? (
          <AppLifecyclePanel
            hasApplication={state.application !== null}
            creating={creating}
            onCreate={handleCreate}
            onCancelCreate={() => setCreating(false)}
            onNew={() => setCreating(true)}
            onOpen={handleOpen}
          />
        ) : viewData ? (
          <ViewContainer
            activeView={state.activeView}
            onChangeView={(view) => setState((s) => ({ ...s, activeView: view }))}
            viewProps={{
              viewData,
              selectedResource: state.selectedResource,
              graphContext,
              onSelectResource: handleSelectResource,
              onNavigateResource: handleNavigateResource,
              onUpdateResource: handleUpdateResource,
              onSelect: handleSelect,
              onClearSelection: handleClearSelection,
            }}
          />
        ) : null}
        <DetailPanel
          selectedResource={state.selectedResource}
          selection={selection}
          viewData={viewData}
          onUpdateResource={handleUpdateResource}
        />
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
