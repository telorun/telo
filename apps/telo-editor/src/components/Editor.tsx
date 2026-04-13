import type { ManifestAdapter } from "@telorun/analyzer";
import { useRef, useState } from "react";
import { useEditorPersistence } from "../hooks/useEditorPersistence";
import {
  addModuleImport,
  classifyImport,
  createApplication,
  createRegistryAdapters,
  getAvailableKinds,
  getYamlStateSnapshots,
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
  ParsedResource,
} from "../model";
import { DEFAULT_SETTINGS } from "../model";
import { CreateResourceModal } from "./CreateResourceModal";
import { DetailPanel } from "./DetailPanel";
import { GraphCanvas } from "./GraphCanvas";
import type { ResolvedResourceOption } from "./ResourceSchemaForm";
import { SettingsModal } from "./SettingsModal";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { YamlStateViewer } from "./YamlStateViewer";

const INITIAL_STATE: EditorState = {
  application: null,
  activeModulePath: null,
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
        navigationStack: nextStack,
        selectedResource: { kind, name },
        panelStack: [{ type: "resource", kind, name }],
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Resource creation
  // ---------------------------------------------------------------------------

  const availableKinds =
    state.application && activeManifest ? getAvailableKinds(state.application, activeManifest) : [];
  const yamlSnapshots = state.application ? getYamlStateSnapshots(state.application) : [];
  const localKinds =
    activeManifest?.resources
      .filter((resource) => resource.kind === "Kernel.Definition")
      .map((resource) => ({
        fullKind: `${resource.module ?? activeManifest.metadata.name}.${resource.name}`,
        alias: resource.module ?? activeManifest.metadata.name,
        kindName: resource.name,
        capability:
          typeof resource.fields.capability === "string" ? resource.fields.capability : "",
        topology:
          typeof resource.fields.topology === "string" ? resource.fields.topology : undefined,
        schema: (resource.fields.schema ?? {}) as Record<string, unknown>,
      })) ?? [];
  const schemaByKind: Record<string, Record<string, unknown>> = Object.fromEntries(
    [...availableKinds, ...localKinds].map((k) => [k.fullKind, k.schema]),
  );
  const kindByFullKind = Object.fromEntries(
    [...availableKinds, ...localKinds].map((k) => [k.fullKind, k]),
  );
  const capabilityByKind: Record<string, string> = Object.fromEntries(
    [...availableKinds, ...localKinds]
      .filter((k) => k.capability)
      .map((k) => [k.fullKind, k.capability]),
  );
  const graphResource =
    graphContext && activeManifest
      ? (activeManifest.resources.find(
          (resource) => resource.kind === graphContext.kind && resource.name === graphContext.name,
        ) ?? null)
      : null;
  const graphKind = graphResource ? (kindByFullKind[graphResource.kind] ?? null) : null;
  const resolvedResources: ResolvedResourceOption[] =
    activeManifest?.resources.map((resource) => ({
      kind: resource.kind,
      name: resource.name,
      capability:
        typeof kindByFullKind[resource.kind]?.capability === "string"
          ? kindByFullKind[resource.kind].capability
          : undefined,
    })) ?? [];

  function handleCreateResource(kind: string, name: string, fields: Record<string, unknown>) {
    if (!state.application || !state.activeModulePath) return;
    const modules = new Map(state.application.modules);
    const current = modules.get(state.activeModulePath)!;
    const newResource: ParsedResource = { kind, name, fields };
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
          availableKinds={availableKinds}
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
        <GraphCanvas
          hasApplication={state.application !== null}
          creating={creating}
          graphResource={graphResource}
          graphTopology={graphKind?.topology}
          graphSchema={graphKind?.schema}
          onUpdateResource={handleUpdateResource}
          onSelect={handleSelect}
          onCreate={handleCreate}
          onCancelCreate={() => setCreating(false)}
          onNew={() => setCreating(true)}
          onOpen={handleOpen}
          onClearSelection={handleClearSelection}
        />
        <DetailPanel
          selectedResource={state.selectedResource}
          selection={selection}
          activeManifest={activeManifest}
          schemaByKind={schemaByKind}
          capabilityByKind={capabilityByKind}
          resolvedResources={resolvedResources}
          onUpdateResource={handleUpdateResource}
        />
        <YamlStateViewer snapshots={yamlSnapshots} activeFilePath={state.activeModulePath} />
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
