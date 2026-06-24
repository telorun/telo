import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { File as FileIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isModuleRootKind, moduleRootResource } from "../application-adapter";
import { analyzeWorkspace } from "../analysis";
import { HistoryManager } from "../history/manager";
import { LocalStorageHistoryStore } from "../history/store";
import { useEditorPersistence } from "../hooks/useEditorPersistence";
import { useImportOps } from "../hooks/useImportOps";
import { useWorkspaceLifecycle } from "../hooks/useWorkspaceLifecycle";
import { INITIAL_STATE, defaultGraphContext, pickInitialActiveModule } from "../editor-state";
import {
  createModule,
  createRegistryAdapters,
  createResourceViaAst,
  deleteModule,
  hasUnresolvedImports,
  loadWorkspace,
  noopAdapter,
  normalizePath,
  persistWorkspaceModule,
  rebuildManifestFromDocuments,
  reconcileImports,
  removeResourceViaAst,
  setResourceFields,
  VIRTUAL_WORKSPACE_ROOT,
} from "../loader";
import { pathBasename, pathDirname, pathJoin } from "../loader/paths";
import { moduleParseError, parseModuleDocument } from "../yaml-document";
import type { CanvasViewport, ModuleDocument } from "../model";
import type {
  EditorState,
  ModuleKind,
  Selection,
  ViewId,
  Workspace,
} from "../model";
import { closeTab, findTab, neighborTab, upsertTab } from "../tabs";
import { DEFAULT_SETTINGS } from "../model";
import {
  readActiveEnvironment,
  setActiveEnvironmentEnv,
} from "../deployment";
import { resolveDeclaredPorts } from "./views/deployment/declared-ports";
import {
  buildRunBundle,
  registry as runRegistry,
  RunView,
  selectModuleFiles,
  TermsRequiredError,
  useRun,
} from "../run";
import type { RunnerTerms } from "../run";
import { saveDeploymentsForWorkspace } from "../storage-deployments";
import { findMissingRequiredEnv } from "./views/deployment/declared-env";
import type { DeclaredEnvEntry } from "./views/deployment/DeclaredEnvEditor";
import { buildModuleViewData } from "../view-data";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "./ui/toast";
import { AppLifecyclePanel } from "./AppLifecyclePanel";
import { CreateResourceModal } from "./CreateResourceModal";
import { EditorTabs } from "./EditorTabs";
import type { TabItem } from "./EditorTabs";
import { FileEditor } from "./views/FileEditor";
import { DiagnosticsProvider } from "./diagnostics/DiagnosticsContext";
import { setActiveRegistry } from "./views/source/register-completion";
import { getModuleFiles } from "../diagnostics-aggregate";
import { SettingsModal } from "./SettingsModal";
import { Sidebar } from "./sidebar/Sidebar";
import { TermsGateDialog } from "./TermsGateDialog";
import { TopBar } from "./TopBar";
import { acceptTermsFor, isTermsAcceptedFor } from "../storage";
import { ViewContainer } from "./views/ViewContainer";
import { refTargetName } from "./views/topology/overview-graph";
import type { RefWrite } from "./views/topology/application-canvas-model";
import { leafConcreteIndex, writeConcretePath } from "../lib/concrete-path";
import type { Range } from "@telorun/analyzer";

/** Shallow, order-sensitive equality for `include:` lists. Used to detect
 *  source-edits that changed the owner module's partial-file set so Editor
 *  can trigger a full workspace reload — `rebuildManifestFromDocuments`
 *  alone doesn't re-run `include:` glob expansion. */
function includesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Activates a module: ensures a module tab exists, makes it the active tab,
 *  and points the module context at it. Resets module-scoped canvas state only
 *  when the active module actually changes, so re-activating an already-open
 *  tab keeps the user's canvas focus. */
function activateModuleState(s: EditorState, filePath: string): EditorState {
  const moduleChanged = s.activeModulePath !== filePath;
  const nextModule = s.workspace?.modules.get(filePath);
  const activeView: ViewId =
    s.activeView === "deployment" && nextModule?.kind !== "Application"
      ? "topology"
      : s.activeView;
  return {
    ...s,
    activeModulePath: filePath,
    activeView,
    openTabs: upsertTab(s.openTabs, { type: "module", path: filePath }),
    activeTabId: filePath,
    graphContext: moduleChanged ? defaultGraphContext(s.workspace, filePath) : s.graphContext,
    selectedResource: moduleChanged ? null : s.selectedResource,
    panelStack: moduleChanged ? [] : s.panelStack,
  };
}

export function Editor() {
  const { state, setState, settings, setSettings, persistedHint } = useEditorPersistence(
    INITIAL_STATE,
    DEFAULT_SETTINGS,
  );
  const runContext = useRun();
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The pending terms gate: the runner's terms, the runner they belong to, and
  // the run to resume once accepted. Null when no gate is shown.
  const [termsGate, setTermsGate] = useState<{
    terms: RunnerTerms;
    runnerId: string;
    filePath: string;
  } | null>(null);
  const [missingEnv, setMissingEnv] = useState<DeclaredEnvEntry[] | null>(null);
  const [createResourceOpen, setCreateResourceOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);

  // Workspace bootstrap (open / restore / remote-import), the adapter refs every
  // other handler reads, the explorer file tree, and the post-file-op reload.
  const {
    loading,
    pendingImport,
    toast,
    setToast,
    fileTree,
    manifestAdapterRef,
    workspaceAdapterRef,
    handleOpen,
    handleConfirmImport,
    onImportDialogOpenChange,
    refreshFileTree,
    afterFileMutation,
  } = useWorkspaceLifecycle({ state, setState, settings, persistedHint, setError });

  const analysisTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // History manager lives in state so (a) construction runs in an effect, not
  // during render, and (b) swapping when rootDir changes triggers a re-render.
  // `historyVersion` bumps on every recordEdit/undo/redo; `canUndo`/`canRedo`
  // depend on it via useMemo so mutable manager state projects cleanly back
  // through React's dep system.
  const [historyManager, setHistoryManager] = useState<HistoryManager | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);

  // Construct (or swap) the HistoryManager when the workspace rootDir changes.
  // Pruning runs on the fresh manager: drop entries for modules no longer in
  // the workspace, and within each kept module drop snapshots whose file is
  // no longer part of the module (so undoing doesn't resurrect files deleted
  // between sessions).
  useEffect(() => {
    const workspace = state.workspace;
    if (!workspace) {
      if (historyManager) setHistoryManager(null);
      return;
    }
    if (historyManager && historyManager.rootDir === workspace.rootDir) return;
    const store = new LocalStorageHistoryStore(workspace.rootDir);
    const mgr = new HistoryManager(store, workspace.rootDir);
    mgr.pruneStaleModules(new Set(workspace.modules.keys()));
    for (const [modPath, manifest] of workspace.modules) {
      mgr.pruneStaleSnapshots(modPath, new Set(getModuleFiles(manifest)));
    }
    setHistoryManager(mgr);
    setHistoryVersion((v) => v + 1);
    // `historyManager` intentionally omitted from deps — it's only checked to
    // skip the swap when rootDir is unchanged; keying on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.workspace]);
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

  // Debounced analysis: re-analyze whenever the workspace changes. Held while
  // external dependencies are still streaming in, so the first paint doesn't
  // flash transient "unresolved import" diagnostics — analysis runs once the
  // dependency merge clears `dependenciesPending` (which produces a new
  // workspace and re-triggers this effect).
  useEffect(() => {
    if (!state.workspace || state.workspace.dependenciesPending) return;
    if (analysisTimerRef.current) clearTimeout(analysisTimerRef.current);
    const workspace = state.workspace;
    analysisTimerRef.current = setTimeout(async () => {
      const manifestAdapter = manifestAdapterRef.current;
      if (!manifestAdapter) return;
      const diagnostics = await analyzeWorkspace(
        workspace,
        manifestAdapter,
        createRegistryAdapters(settings),
      );
      setState((s) => {
        if (s.workspace !== workspace) return s;
        return { ...s, diagnostics };
      });
    }, 300);
    return () => {
      if (analysisTimerRef.current) clearTimeout(analysisTimerRef.current);
    };
  }, [state.workspace]);

  // Point the completion provider at the registry of the active module's
  // analysis closure. Each Application (and orphan library) owns an isolated
  // registry, so completion reflects exactly the kinds in scope for the file
  // being edited — never a sibling app's differently-versioned imports.
  useEffect(() => {
    const path = state.activeModulePath;
    setActiveRegistry(path ? state.diagnostics.registryByFile.get(path) : undefined);
  }, [state.diagnostics, state.activeModulePath]);

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

  // Run history + status for the active Application — drives the TopBar Run
  // button's status dot and its chevron dropdown of recent runs.
  const activeAppPath =
    activeManifest?.kind === "Application" ? activeManifest.filePath : null;
  const activeAppRuns = activeAppPath ? runContext.runsForApp(activeAppPath) : [];
  const activeAppRun = activeAppPath
    ? (runContext.liveRunForApp(activeAppPath) ?? runContext.latestRunForApp(activeAppPath))
    : null;

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
      openTabs: upsertTab(s.openTabs, { type: "module", path: newFilePath }),
      activeTabId: newFilePath,
      graphContext: defaultGraphContext(updated, newFilePath),
      selectedResource: null,
      panelStack: [],
    }));
    void refreshFileTree(updated);
  }

  async function handleDeleteModule(filePath: string) {
    const workspace = state.workspace;
    const adapter = workspaceAdapterRef.current;
    if (!workspace || !adapter) return;
    const updated = await deleteModule(workspace, filePath, adapter);
    setState((s) => {
      const openTabs = closeTab(s.openTabs, filePath);
      const wasActiveTab = s.activeTabId === filePath;
      const nextActive =
        s.activeModulePath === filePath
          ? pickInitialActiveModule(updated)
          : s.activeModulePath;
      const moduleChanged = nextActive !== s.activeModulePath;
      let finalTabs = openTabs;
      let activeTabId = s.activeTabId;
      if (wasActiveTab) {
        if (nextActive) {
          finalTabs = upsertTab(openTabs, { type: "module", path: nextActive });
          activeTabId = nextActive;
        } else {
          activeTabId = openTabs[0]?.path ?? null;
        }
      }
      return {
        ...s,
        workspace: updated,
        activeModulePath: nextActive,
        openTabs: finalTabs,
        activeTabId,
        graphContext: moduleChanged ? null : s.graphContext,
        selectedResource: moduleChanged ? null : s.selectedResource,
        panelStack: moduleChanged ? [] : s.panelStack,
      };
    });
    void refreshFileTree(updated);
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

    const runner = settings.runners.find((r) => r.id === settings.activeRunnerId);
    if (!runner) {
      setError("No runner selected. Add or select a runner in Settings.");
      setSettingsOpen(true);
      return;
    }

    const adapter = runRegistry.get(runner.adapterId);
    if (!adapter) {
      setError(`Runner "${runner.name}" uses an unavailable adapter "${runner.adapterId}".`);
      setSettingsOpen(true);
      return;
    }

    const config = runner.config ?? adapter.defaultConfig;

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

    // Terms gate: the runner is the authority on whether running requires
    // accepting an agreement. Fetch its terms (runner reachable — availability is
    // ready here); if present and not yet accepted for this runner+version, show
    // the gate and stop. The accepted version rides along on the run request and
    // is enforced server-side.
    let terms: RunnerTerms | null = null;
    try {
      terms = (await adapter.getTerms?.(config)) ?? null;
    } catch (err) {
      setError(
        `Failed to read runner terms: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (terms && !isTermsAcceptedFor(runner.id, terms.version)) {
      setTermsGate({ terms, runnerId: runner.id, filePath });
      return;
    }
    const acceptedTermsVersion = terms?.version;

    const liveRun = runContext.liveRunForApp(filePath);
    if (liveRun) {
      const proceed = window.confirm("Stop the current run and start a new one?");
      if (!proceed) return;
      await runContext.stopRun(liveRun.id);
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

    // Pre-flight required variables/secrets so a missing value sends the user to
    // the Deployment tab instead of failing at boot with a validation error.
    const manifest =
      activeManifest?.filePath === filePath
        ? activeManifest
        : ([...workspace.modules.values()].find((m) => m.filePath === filePath) ?? null);
    const missing = findMissingRequiredEnv(manifest, environment.env);
    if (missing.length > 0) {
      setMissingEnv(missing);
      return;
    }

    let bundle;
    try {
      bundle = await buildRunBundle(
        workspace,
        filePath,
        (p) => workspaceAdapter.readFile(p),
        (base, patterns) =>
          selectModuleFiles(base, patterns, (dir) => workspaceAdapter.listDir(dir)),
      );
    } catch (err) {
      setError(
        `Failed to build run bundle: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    try {
      await runContext.startRun({
        appPath: filePath,
        adapter,
        config,
        request: {
          bundle,
          env: environment.env,
          ports: resolveDeclaredPorts(manifest, environment.env),
          acceptedTermsVersion,
        },
      });
    } catch (err) {
      // Safety net: the runner enforces terms server-side, so even if the gate
      // was skipped (e.g. the version changed since we fetched it) it can reject
      // with the current terms — surface the gate and let the user retry.
      if (err instanceof TermsRequiredError) {
        setTermsGate({ terms: err.terms, runnerId: runner.id, filePath });
        return;
      }
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
   *  notices before data diverges from the in-memory state.
   *
   *  Records a history snapshot for every file actually written, unless
   *  `skipHistory` is set (true during undo/redo to avoid re-recording the
   *  restore itself, which would shadow the redo tail). */
  async function persistModule(
    workspace: Workspace,
    filePath: string,
    opts?: { skipHistory?: boolean },
  ): Promise<Workspace> {
    const adapter = workspaceAdapterRef.current;
    if (!adapter) return workspace;

    const mgr = opts?.skipHistory ? null : historyManager;
    const preTexts = new Map<string, string>();
    if (mgr) {
      const manifest = workspace.modules.get(filePath);
      if (manifest) {
        // Pre-edit text must come from `state.workspace.documents` (the
        // closure-captured pre-edit snapshot), not the passed-in workspace —
        // for source-view edits, the caller has already stamped the user's
        // typed text into `workspace.documents[fp].text`, so reading from
        // `workspace` would yield the post-edit text and produce no diff.
        // Form-edit call sites don't touch `.text`, so both sources agree
        // for those paths.
        const prevDocs = state.workspace?.documents;
        for (const fp of getModuleFiles(manifest)) {
          const doc = prevDocs?.get(fp) ?? workspace.documents.get(fp);
          if (doc) preTexts.set(fp, doc.loaded.text);
        }
      }
    }

    let next: Workspace;
    try {
      next = await persistWorkspaceModule(workspace, filePath, adapter);
    } catch (err) {
      setError(`Failed to save ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      return workspace;
    }

    if (mgr && preTexts.size > 0) {
      let recorded = false;
      const timestamp = Date.now();
      for (const [fp, before] of preTexts) {
        const after = next.documents.get(fp)?.loaded.text;
        if (after === undefined || after === before) continue;
        mgr.recordEdit(filePath, { filePath: fp, before, after, timestamp });
        recorded = true;
      }
      if (recorded) setHistoryVersion((v) => v + 1);
    }

    return next;
  }

  // Import authoring for the active module — add / remove / upgrade.
  const { handleAddImport, handleRemoveImport, handleUpgradeImport, handleUpgradeAllImports } =
    useImportOps({ state, setState, settings, manifestAdapterRef, persistModule });

  // ---------------------------------------------------------------------------
  // Navigation (direct set, no stack)
  // ---------------------------------------------------------------------------

  function handleOpenModule(filePath: string) {
    runContext.closeRunView();
    setSelection(null);
    setState((s) => activateModuleState(s, filePath));
  }

  // ---------------------------------------------------------------------------
  // Tab + file navigation
  // ---------------------------------------------------------------------------

  /** Opens any workspace file. A module owner opens (or re-activates) its module
   *  tab; a partial of a module opens the owner module's source view revealing
   *  that file; any other file opens a raw Monaco file tab. */
  function handleOpenFile(filePath: string) {
    const workspace = state.workspace;
    if (!workspace) return;
    const key = normalizePath(filePath);

    if (workspace.modules.has(key)) {
      handleOpenModule(key);
      return;
    }

    for (const [modulePath, manifest] of workspace.modules) {
      if (getModuleFiles(manifest).includes(key)) {
        runContext.closeRunView();
        setSelection(null);
        revealNonceRef.current += 1;
        setState((s) => ({
          ...activateModuleState(s, modulePath),
          activeView: "source" as ViewId,
          sourceRevealRequest: { filePath: key, nonce: revealNonceRef.current },
        }));
        return;
      }
    }

    runContext.closeRunView();
    setState((s) => ({
      ...s,
      openTabs: upsertTab(s.openTabs, { type: "file", path: key }),
      activeTabId: key,
    }));
  }

  function handleActivateTab(path: string) {
    const tab = findTab(state.openTabs, path);
    if (!tab) return;
    if (tab.type === "module") {
      handleOpenModule(path);
      return;
    }
    runContext.closeRunView();
    setState((s) => ({ ...s, activeTabId: path }));
  }

  function handleCloseTab(path: string) {
    setState((s) => {
      const openTabs = closeTab(s.openTabs, path);
      if (s.activeTabId !== path) return { ...s, openTabs };
      const neighbor = neighborTab(s.openTabs, path);
      if (neighbor?.type === "module") {
        return { ...activateModuleState({ ...s, openTabs }, neighbor.path) };
      }
      return { ...s, openTabs, activeTabId: neighbor?.path ?? null };
    });
  }

  function handleToggleDir(path: string) {
    setState((s) => ({
      ...s,
      expandedDirs: s.expandedDirs.includes(path)
        ? s.expandedDirs.filter((d) => d !== path)
        : [...s.expandedDirs, path],
    }));
  }

  // ---------------------------------------------------------------------------
  // Raw file operations (explorer)
  // ---------------------------------------------------------------------------

  const readFileCb = useCallback(
    (p: string) => workspaceAdapterRef.current!.readFile(p),
    [],
  );
  const saveFileCb = useCallback(
    (p: string, text: string) => workspaceAdapterRef.current!.writeFile(p, text),
    [],
  );

  async function handleCreateFile(parentDir: string, name: string) {
    const adapter = workspaceAdapterRef.current;
    if (!adapter) return;
    const path = pathJoin(parentDir, name);
    try {
      await adapter.writeFile(path, "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    await afterFileMutation([path]);
    handleOpenFile(path);
  }

  async function handleCreateFolder(parentDir: string, name: string) {
    const adapter = workspaceAdapterRef.current;
    if (!adapter) return;
    const path = pathJoin(parentDir, name);
    try {
      await adapter.createDir(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setState((s) => ({
      ...s,
      expandedDirs: s.expandedDirs.includes(path) ? s.expandedDirs : [...s.expandedDirs, path],
    }));
    await afterFileMutation([path]);
  }

  async function handleRenamePath(path: string, newName: string) {
    const adapter = workspaceAdapterRef.current;
    if (!adapter) return;
    const dest = pathJoin(pathDirname(path), newName);
    if (dest === path) return;
    try {
      await adapter.rename(path, dest);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    remapPaths(path, dest);
    await afterFileMutation([path, dest]);
  }

  async function handleMovePath(from: string, toDir: string) {
    const adapter = workspaceAdapterRef.current;
    if (!adapter) return;
    if (toDir === pathDirname(from)) return;
    // Refuse to move a directory into itself or a descendant.
    if (toDir === from || toDir.startsWith(from + "/")) return;
    const dest = pathJoin(toDir, pathBasename(from));
    try {
      await adapter.rename(from, dest);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    remapPaths(from, dest);
    await afterFileMutation([from, dest]);
  }

  async function handleDeletePath(path: string) {
    const adapter = workspaceAdapterRef.current;
    if (!adapter) return;
    if (!window.confirm(`Delete ${pathBasename(path)}? This cannot be undone.`)) return;
    try {
      await adapter.delete(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    closePathsUnder(path);
    await afterFileMutation([path]);
  }

  // Rewrites open tabs / active path / expanded dirs after a file or directory
  // moves from `from` to `dest` (covers the moved node and everything under it).
  function remapPaths(from: string, dest: string) {
    const remap = (p: string): string =>
      p === from ? dest : p.startsWith(from + "/") ? dest + p.slice(from.length) : p;
    setState((s) => ({
      ...s,
      openTabs: s.openTabs.map((t) => ({ ...t, path: remap(t.path) })),
      activeTabId: s.activeTabId ? remap(s.activeTabId) : s.activeTabId,
      activeModulePath: s.activeModulePath ? remap(s.activeModulePath) : s.activeModulePath,
      expandedDirs: s.expandedDirs.map(remap),
    }));
  }

  // Closes any tab whose file is `path` or lives under it (directory delete).
  function closePathsUnder(path: string) {
    const under = (p: string) => p === path || p.startsWith(path + "/");
    setState((s) => {
      const openTabs = s.openTabs.filter((t) => !under(t.path));
      const activeTabId =
        s.activeTabId && under(s.activeTabId)
          ? (openTabs[0]?.path ?? null)
          : s.activeTabId;
      const activeModulePath =
        s.activeModulePath && under(s.activeModulePath) ? null : s.activeModulePath;
      return {
        ...s,
        openTabs,
        activeTabId,
        activeModulePath,
        expandedDirs: s.expandedDirs.filter((d) => !under(d)),
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

  function handleCanvasViewportChange(viewport: CanvasViewport) {
    setState((s) =>
      s.activeModulePath
        ? { ...s, viewportByModule: { ...s.viewportByModule, [s.activeModulePath]: viewport } }
        : s,
    );
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
    const owner = ownerPath;
    setState((s) => {
      const base = owner ? activateModuleState(s, owner) : s;
      return {
        ...base,
        activeView: "source" as ViewId,
        sourceRevealRequest: { filePath: normalized, range, nonce: revealNonceRef.current },
      };
    });
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
    if (!manifest) return;
    // The module root isn't in `manifest.resources`; project its prior fields
    // from the manifest so the generic writer can diff against them.
    const prev =
      manifest.resources.find((r) => r.kind === kind && r.name === name) ??
      (isModuleRootKind(kind) ? moduleRootResource(manifest) : undefined);
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

  async function handleDeleteResource(kind: string, name: string) {
    if (!state.workspace || !state.activeModulePath) return;
    let updated = removeResourceViaAst(state.workspace, state.activeModulePath, kind, name);
    if (updated === state.workspace) return;

    // Prune every now-dangling ref to the deleted resource — any slot on any
    // node (targets, a picker's `uses`, a server's `notFoundHandler`, a step
    // invoke) — otherwise the manifest keeps a broken `!ref` the canvas silently
    // hides. Schema-driven via the visitor, so all ref shapes and nesting are
    // covered; the Application root rides along as a synthesized manifest.
    updated = pruneDanglingRefs(updated, state.activeModulePath, name);

    const persisted = await persistModule(updated, state.activeModulePath);
    const matches = (r: { kind: string; name: string } | null) =>
      r?.kind === kind && r?.name === name;
    if (matches(selection?.resource ?? null)) setSelection(null);
    setState((s) => ({
      ...s,
      workspace: persisted,
      selectedResource: matches(s.selectedResource) ? null : s.selectedResource,
      panelStack: matches(s.selectedResource) ? [] : s.panelStack,
      graphContext: matches(s.graphContext) ? null : s.graphContext,
    }));
  }

  // Clears every ref slot pointing at `deleted` across the module — found via
  // the analysis registry's visitor (every ref shape and nesting), then routed
  // through the generic ref writer. The Application root is fed in as a
  // synthesized manifest so its `targets` are pruned the same way.
  function pruneDanglingRefs(ws: Workspace, modulePath: string, deleted: string): Workspace {
    const registry = state.diagnostics.registryByFile.get(modulePath);
    const manifest = ws.modules.get(modulePath);
    if (!registry || !manifest) return ws;

    const root = moduleRootResource(manifest);
    const asManifest = (r: { kind: string; name: string; fields: Record<string, unknown> }) =>
      ({ kind: r.kind, metadata: { name: r.name }, ...r.fields }) as unknown as ResourceManifest;
    const resources = [
      ...manifest.resources.filter((r) => !isModuleRootKind(r.kind)).map(asManifest),
      asManifest(root),
    ];

    const writes: RefWrite[] = [];
    registry.visitManifest(
      resources,
      {
        onRef: (e) => {
          if (refTargetName(e.value) !== deleted) return;
          const srcName = e.source.metadata?.name;
          if (typeof e.source.kind === "string" && typeof srcName === "string") {
            writes.push({
              source: { kind: e.source.kind, name: srcName },
              concretePath: e.concretePath,
              target: null,
            });
          }
        },
      },
      { expand: true, discoverNestedRefs: true },
    );
    return writes.length ? applyRefWrites(ws, modulePath, writes) : ws;
  }

  // Applies a batch of reference writes from the overview canvas. Writes are
  // grouped per source resource and ordered (removals high-to-low, then sets) so
  // simultaneous array edits stay consistent; each group diffs once via the
  // generic field writer. The Application root's `targets` is just another
  // resource here — no special-casing.
  function applyRefWrites(ws: Workspace, modulePath: string, writes: RefWrite[]): Workspace {
    const bySource = new Map<string, RefWrite[]>();
    for (const w of writes) {
      const key = `${w.source.kind}::${w.source.name}`;
      const list = bySource.get(key);
      if (list) list.push(w);
      else bySource.set(key, [w]);
    }

    let result = ws;
    for (const group of bySource.values()) {
      const { kind, name } = group[0].source;
      const manifest = result.modules.get(modulePath);
      if (!manifest) continue;
      const src =
        manifest.resources.find((r) => r.kind === kind && r.name === name) ??
        (isModuleRootKind(kind) ? moduleRootResource(manifest) : undefined);
      if (!src) continue;

      const ordered = [...group].sort((a, b) => {
        const ra = a.target === null ? 0 : 1;
        const rb = b.target === null ? 0 : 1;
        if (ra !== rb) return ra - rb;
        return leafConcreteIndex(b.concretePath) - leafConcreteIndex(a.concretePath);
      });
      const newFields = structuredClone(src.fields);
      for (const w of ordered) {
        writeConcretePath(
          newFields,
          w.concretePath,
          w.target === null ? null : makeTaggedSentinel("ref", w.target),
        );
      }
      result = setResourceFields(result, modulePath, src.kind, src.name, src.fields, newFields);
    }
    return result;
  }

  // A resource name derived from a kind (`Ai.Tools` → `Tools`), de-duplicated
  // against existing resources so a fresh create-and-link never collides.
  function uniqueResourceName(
    manifest: { resources: { name: string }[] } | undefined,
    kind: string,
  ): string {
    const base = kind.includes(".") ? kind.slice(kind.lastIndexOf(".") + 1) : kind;
    const taken = new Set((manifest?.resources ?? []).map((r) => r.name));
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base}${i}`)) i++;
    return `${base}${i}`;
  }

  async function handleWriteRef(writes: RefWrite[]) {
    if (!state.workspace || !state.activeModulePath || writes.length === 0) return;
    const modulePath = state.activeModulePath;
    let ws = state.workspace;
    // Create-and-link writes: materialize the new resource first, then link the
    // slot to it by the generated name.
    const resolved: RefWrite[] = writes.map((w) => {
      if (!w.createKind) return w;
      const name = uniqueResourceName(ws.modules.get(modulePath), w.createKind);
      ws = createResourceViaAst(ws, modulePath, w.createKind, name, {});
      return { source: w.source, concretePath: w.concretePath, target: name };
    });
    const updated = applyRefWrites(ws, modulePath, resolved);
    if (updated === state.workspace) return;
    const persisted = await persistModule(updated, modulePath);
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
  async function handleSourceEdit(
    filePath: string,
    moduleDoc: ModuleDocument,
    opts?: { skipHistory?: boolean },
  ) {
    if (!state.workspace || !state.activeModulePath) return;

    // All writes to `documents` go through the canonical `normalizePath`
    // key, matching every other mutation site. The `ModuleDocument.filePath`
    // field carries the display path for disk writes (adapter.writeFile),
    // but lookups only ever use the canonical key.
    const key = normalizePath(filePath);
    const documents = new Map(state.workspace.documents);
    // Preserve the previous LoadedFile's text/manifests/positions as the
    // load-time snapshot — those fields drive the no-op-save guard in
    // `saveModuleFromDocuments`. A source-edit produces a fresh
    // `parseModuleDocument` whose snapshot matches its own current docs,
    // which would make the guard see "no change" and skip the disk write —
    // silently dropping the edit on the next workspace reload.
    const prevDoc = state.workspace.documents.get(key);
    const merged: ModuleDocument = prevDoc
      ? {
          filePath: moduleDoc.filePath,
          loaded: {
            ...moduleDoc.loaded,
            text: prevDoc.loaded.text,
            manifests: prevDoc.loaded.manifests,
            positions: prevDoc.loaded.positions,
          },
          dirty: true,
        }
      : { ...moduleDoc, dirty: true };
    documents.set(key, merged);

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

    workspace = await persistModule(workspace, state.activeModulePath, {
      skipHistory: opts?.skipHistory,
    });

    // `saveModuleFromDocuments` re-parses the just-written text, producing
    // a fresh `loaded` with normalized formatting. For source edits the
    // user's typed text is authoritative — if the serializer reformats it
    // (adds leading `---`, normalizes whitespace, etc.), the SourceView's
    // resync effect would push the reformatted text into Monaco via
    // `setValue`, which jumps the cursor to the top. Restore the user's
    // text in `loaded.text` so the buffer stays stable; disk holds the
    // serialized form, and `loaded.manifests` already reflects the
    // persisted snapshot for future change detection.
    const persistedDoc = workspace.documents.get(key);
    if (persistedDoc && persistedDoc.loaded.text !== moduleDoc.loaded.text) {
      const patched = new Map(workspace.documents);
      patched.set(key, {
        ...persistedDoc,
        loaded: { ...persistedDoc.loaded, text: moduleDoc.loaded.text },
      });
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
  // Undo / redo
  // ---------------------------------------------------------------------------

  async function handleUndo() {
    const modulePath = state.activeModulePath;
    if (!historyManager || !modulePath || !state.workspace) return;
    const snap = historyManager.undo(modulePath);
    if (!snap) return;
    setHistoryVersion((v) => v + 1);
    const moduleDoc = parseModuleDocument(snap.filePath, snap.before);
    const undoErr = moduleParseError(moduleDoc);
    if (undoErr) {
      console.error(
        `Undo: snapshot text for ${snap.filePath} failed to re-parse — leaving disk unchanged`,
        undoErr,
      );
      return;
    }
    await handleSourceEdit(snap.filePath, moduleDoc, { skipHistory: true });
  }

  async function handleRedo() {
    const modulePath = state.activeModulePath;
    if (!historyManager || !modulePath || !state.workspace) return;
    const snap = historyManager.redo(modulePath);
    if (!snap) return;
    setHistoryVersion((v) => v + 1);
    const moduleDoc = parseModuleDocument(snap.filePath, snap.after);
    const redoErr = moduleParseError(moduleDoc);
    if (redoErr) {
      console.error(
        `Redo: snapshot text for ${snap.filePath} failed to re-parse — leaving disk unchanged`,
        redoErr,
      );
      return;
    }
    await handleSourceEdit(snap.filePath, moduleDoc, { skipHistory: true });
  }

  const canUndo = useMemo(
    () =>
      !!historyManager &&
      !!state.activeModulePath &&
      historyManager.canUndo(state.activeModulePath),
    [historyManager, state.activeModulePath, historyVersion],
  );
  const canRedo = useMemo(
    () =>
      !!historyManager &&
      !!state.activeModulePath &&
      historyManager.canRedo(state.activeModulePath),
    [historyManager, state.activeModulePath, historyVersion],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const activeTab = findTab(state.openTabs, state.activeTabId);
  const expandedDirsSet = useMemo(() => new Set(state.expandedDirs), [state.expandedDirs]);
  const tabItems: TabItem[] = state.openTabs.map((t) => {
    const active = t.path === state.activeTabId;
    if (t.type === "module") {
      const m = state.workspace?.modules.get(t.path);
      return {
        path: t.path,
        label: m?.metadata.name ?? pathBasename(t.path),
        icon: <span className="text-zinc-400">{m?.kind === "Library" ? "□" : "▷"}</span>,
        active,
      };
    }
    return {
      path: t.path,
      label: pathBasename(t.path),
      icon: <FileIcon className="size-3.5" />,
      active,
    };
  });

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
        runStatus={activeAppRun?.status ?? null}
        runs={activeAppRuns}
        onSelectRun={runContext.selectRun}
        onUndo={canUndo ? () => void handleUndo() : undefined}
        onRedo={canRedo ? () => void handleRedo() : undefined}
        canUndo={canUndo}
        canRedo={canRedo}
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
          activeModulePath={state.activeModulePath}
          activeTabId={state.activeTabId}
          fileTree={fileTree}
          expandedDirs={expandedDirsSet}
          onToggleDir={handleToggleDir}
          onOpenFile={handleOpenFile}
          onCreateFile={handleCreateFile}
          onCreateFolder={handleCreateFolder}
          onRenamePath={handleRenamePath}
          onDeletePath={handleDeletePath}
          onMovePath={handleMovePath}
          onOpenModule={handleOpenModule}
          onCreateModule={handleCreateModule}
          onDeleteModule={handleDeleteModule}
          onRunModule={handleRunModule}
        />
        {runContext.isRunViewOpen ? (
          <RunView />
        ) : !state.workspace ? (
          <AppLifecyclePanel onOpen={handleOpen} recentRootDir={persistedHint?.rootDir} />
        ) : (
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <EditorTabs items={tabItems} onActivate={handleActivateTab} onClose={handleCloseTab} />
            <div className="flex min-h-0 flex-1 overflow-hidden">
              {activeTab?.type === "file" ? (
                <FileEditor
                  key={activeTab.path}
                  filePath={activeTab.path}
                  readFile={readFileCb}
                  saveFile={saveFileCb}
                />
              ) : activeTab?.type === "module" && viewData ? (
                <ViewContainer
                  activeView={state.activeView}
                  onChangeView={(view) => setState((s) => ({ ...s, activeView: view }))}
                  viewProps={{
                      viewData,
                      registry:
                        (state.activeModulePath
                          ? state.diagnostics.registryByFile.get(state.activeModulePath)
                          : undefined) ?? null,
                      selectedResource: state.selectedResource,
                      selection,
                      graphContext: state.graphContext,
                      onSelectResource: handleSelectResource,
                      onNavigateResource: handleNavigateResource,
                      onUpdateResource: handleUpdateResource,
                      onDeleteResource: handleDeleteResource,
                      onWriteRef: handleWriteRef,
                      onCreateResource: () => setCreateResourceOpen(true),
                      registryServers: settings.registryServers,
                      onAddImport: handleAddImport,
                      onRemoveImport: handleRemoveImport,
                      onUpgradeImport: handleUpgradeImport,
                      onUpgradeAllImports: handleUpgradeAllImports,
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
                      canvasViewport: state.activeModulePath
                        ? (state.viewportByModule[state.activeModulePath] ?? null)
                        : null,
                      onCanvasViewportChange: handleCanvasViewportChange,
                    }}
                  />
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-zinc-50 px-6 text-center dark:bg-zinc-900">
                  <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    {state.workspace.modules.size === 0
                      ? "This workspace has no modules yet"
                      : "Nothing open"}
                  </p>
                  <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-500">
                    Open a file from the Explorer, or pick an Application or Library from the
                    sidebar.
                  </p>
                </div>
              )}
            </div>
          </div>
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
      <TermsGateDialog
        terms={termsGate?.terms ?? null}
        onAccept={() => {
          if (!termsGate) return;
          acceptTermsFor(termsGate.runnerId, termsGate.terms.version);
          const { filePath } = termsGate;
          setTermsGate(null);
          void handleRunModuleRef.current(filePath);
        }}
        onDecline={() => setTermsGate(null)}
      />
      <AlertDialog open={pendingImport !== null} onOpenChange={onImportDialogOpenChange}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Open in Telo Editor</AlertDialogTitle>
            <AlertDialogDescription>
              You are about to import this {pendingImport?.plan.kind === "Library" ? "library" : "application"} into your workspace:
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingImport && (
            <div className="max-h-[50vh] space-y-3 overflow-auto text-sm">
              <div>
                <div className="font-medium">{pendingImport.plan.name}</div>
                {pendingImport.plan.description && (
                  <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">
                    {pendingImport.plan.description.trim()}
                  </p>
                )}
              </div>
              {pendingImport.plan.imports.length > 0 && (
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Imports
                  </div>
                  <ul className="mt-1 space-y-0.5">
                    {pendingImport.plan.imports.map((imp) => (
                      <li key={imp.name} className="break-all">
                        <code>{imp.name}</code>: {imp.source}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Files to create
                </div>
                <ul className="mt-1 space-y-0.5">
                  {pendingImport.plan.files.map((f) => (
                    <li key={f.destPath} className="break-all">
                      <code>
                        {f.destPath.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)
                          ? f.destPath.slice(VIRTUAL_WORKSPACE_ROOT.length + 1)
                          : f.destPath}
                      </code>
                      {f.exists && <span className="text-amber-600 dark:text-amber-400"> (overwrite)</span>}
                    </li>
                  ))}
                </ul>
              </div>
              {pendingImport.plan.errors.length > 0 && (
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-destructive">
                    Could not load
                  </div>
                  <ul className="mt-1 space-y-0.5 text-destructive">
                    {pendingImport.plan.errors.map((e) => (
                      <li key={e.url} className="break-all">
                        <code>{e.url}</code> — {e.message}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs text-muted-foreground">
                    These dependencies will be missing from the imported workspace.
                  </p>
                </div>
              )}
              {pendingImport.plan.warnings.length > 0 && (
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
                    Warnings
                  </div>
                  <ul className="mt-1 space-y-0.5 text-amber-600 dark:text-amber-400">
                    {pendingImport.plan.warnings.map((w) => (
                      <li key={w} className="break-all">
                        {w}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={pendingImport?.plan.files.some((f) => f.exists) ? "destructive" : "default"}
              onClick={() => void handleConfirmImport()}
            >
              {pendingImport?.plan.files.some((f) => f.exists) ? "Overwrite & import" : "Import"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={missingEnv !== null} onOpenChange={(open) => !open && setMissingEnv(null)}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Missing required configuration</AlertDialogTitle>
            <AlertDialogDescription>
              This Application declares required values with no default. Fill them in the
              Deployment tab before running:
            </AlertDialogDescription>
          </AlertDialogHeader>
          {missingEnv && (
            <ul className="max-h-[50vh] space-y-1 overflow-auto text-sm">
              {missingEnv.map((entry) => (
                <li key={entry.envVar} className="flex items-baseline gap-2">
                  <code className="font-medium">{entry.name}</code>
                  <span className="text-xs text-muted-foreground">{entry.envVar}</span>
                  <span className="text-xs text-muted-foreground">
                    ({entry.secret ? "secret" : "variable"})
                  </span>
                </li>
              ))}
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => setState((s) => ({ ...s, activeView: "deployment" as ViewId }))}
            >
              Open Deployment tab
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ToastProvider>
        <Toast
          open={toast !== null}
          onOpenChange={(open) => {
            if (!open) setToast(null);
          }}
          duration={6000}
        >
          <div className="grid gap-0.5">
            <ToastTitle>{toast?.title}</ToastTitle>
            {toast?.description && <ToastDescription>{toast.description}</ToastDescription>}
          </div>
          <ToastClose />
        </Toast>
        <ToastViewport />
      </ToastProvider>
    </div>
    </DiagnosticsProvider>
  );
}
