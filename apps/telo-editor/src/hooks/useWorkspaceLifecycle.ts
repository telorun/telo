import type { ManifestSource } from "@telorun/analyzer";
import { useEffect, useRef, useState } from "react";
import {
  buildFileTree,
  buildRemoteImportPlan,
  clearManifestUrlParam,
  createRegistryAdapters,
  createVirtualWorkspaceAdapter,
  loadWorkspace,
  loadWorkspaceDependencies,
  mergeWorkspaceDependencies,
  normalizePath,
  openWorkspaceDirectory,
  readManifestUrlParam,
  reopenWorkspaceAt,
  VIRTUAL_WORKSPACE_ROOT,
  writeRemoteImportPlan,
} from "../loader";
import type { FileNode, RemoteImportPlan } from "../loader";
import { pathBasename } from "../loader/paths";
import type {
  AppSettings,
  EditorState,
  EditorTab,
  ViewId,
  Workspace,
  WorkspaceAdapter,
} from "../model";
import { loadDeploymentsForWorkspace } from "../storage-deployments";
import { getModuleFiles } from "../diagnostics-aggregate";
import { INITIAL_STATE, defaultGraphContext, pickInitialActiveModule } from "../editor-state";
import {
  setActiveSettings,
  setActiveWorkspaceAdapter,
} from "../components/views/source/register-completion";
import type { PersistedEditorState } from "./useEditorPersistence";

/** A resolved remote-open plan (root + same-origin relative cascade), held
 *  until the user confirms or cancels importing it into the workspace. */
export interface PendingImport {
  adapter: ManifestSource & WorkspaceAdapter;
  plan: RemoteImportPlan;
}

/** Restores persisted tabs against a freshly-loaded workspace: drops module
 *  tabs whose module no longer exists (file tabs are kept — the FileEditor
 *  surfaces a missing file itself), ensures the active module has a tab, and
 *  picks a valid active tab. */
function restoreTabs(
  workspace: Workspace,
  persisted: { openTabs: EditorTab[]; activeTabId: string | null },
  activeModulePath: string | null,
): { openTabs: EditorTab[]; activeTabId: string | null } {
  let openTabs = persisted.openTabs.filter(
    (t) => t.type === "file" || workspace.modules.has(t.path),
  );
  if (activeModulePath && !openTabs.some((t) => t.type === "module" && t.path === activeModulePath)) {
    openTabs = [...openTabs, { type: "module", path: activeModulePath }];
  }
  const activeTabId =
    persisted.activeTabId && openTabs.some((t) => t.path === persisted.activeTabId)
      ? persisted.activeTabId
      : (activeModulePath ?? openTabs[0]?.path ?? null);
  return { openTabs, activeTabId };
}

/** Whether a created / renamed / moved / deleted path could change module
 *  discovery or parsing — a `telo.yaml` (any location), or a path that is (or
 *  contains) a file currently tracked as part of a module. Used to decide
 *  whether a file op needs a full workspace reload or just a tree refresh. */
function affectsModuleStructure(workspace: Workspace, p: string): boolean {
  const base = pathBasename(p);
  if (base === "telo.yaml" || base === "telo.yml") return true;
  const key = normalizePath(p);
  for (const manifest of workspace.modules.values()) {
    for (const f of getModuleFiles(manifest)) {
      if (f === key || f.startsWith(key + "/")) return true;
    }
  }
  return false;
}

/** Reconciles open tabs against a freshly-reloaded workspace: drops module
 *  tabs whose module no longer exists, keeps file tabs, and repairs the active
 *  tab / module pointers. Used after a structural file op reloads the
 *  workspace. */
function reconcileWorkspaceTabs(s: EditorState, reloaded: Workspace): EditorState {
  const openTabs = s.openTabs.filter((t) => t.type === "file" || reloaded.modules.has(t.path));
  let activeTabId = s.activeTabId;
  if (activeTabId && !openTabs.some((t) => t.path === activeTabId)) {
    activeTabId = openTabs[0]?.path ?? null;
  }
  const activeTab = openTabs.find((t) => t.path === activeTabId) ?? null;
  let activeModulePath = s.activeModulePath;
  if (activeTab?.type === "module") activeModulePath = activeTab.path;
  else if (activeModulePath && !reloaded.modules.has(activeModulePath)) activeModulePath = null;
  return { ...s, workspace: reloaded, openTabs, activeTabId, activeModulePath };
}

export interface UseWorkspaceLifecycleParams {
  state: EditorState;
  setState: React.Dispatch<React.SetStateAction<EditorState>>;
  settings: AppSettings;
  persistedHint: PersistedEditorState | null;
  setError: (error: string | null) => void;
}

export interface WorkspaceLifecycle {
  loading: boolean;
  pendingImport: PendingImport | null;
  toast: { title: string; description?: string } | null;
  setToast: React.Dispatch<
    React.SetStateAction<{ title: string; description?: string } | null>
  >;
  fileTree: FileNode[];
  /** Source for raw manifest reads (registry / disk); shared with import ops
   *  and source edits. */
  manifestAdapterRef: React.RefObject<ManifestSource | null>;
  /** Source for workspace file I/O; shared with file ops, run, and persist. */
  workspaceAdapterRef: React.RefObject<WorkspaceAdapter | null>;
  handleOpen: () => Promise<void>;
  handleConfirmImport: () => Promise<void>;
  /** Drives the remote-import AlertDialog's open state: confirms ride the
   *  `confirming` latch; everything else cancels and falls back to restore. */
  onImportDialogOpenChange: (open: boolean) => void;
  refreshFileTree: (ws?: Workspace | null) => Promise<void>;
  afterFileMutation: (affected: string[]) => Promise<void>;
}

/** Owns workspace bootstrap: open / restore / remote-import, the adapter refs
 *  every other handler reads, the explorer file tree, and the post-file-op
 *  reload-or-refresh decision. Keeps the `Editor` component focused on module
 *  and resource editing. */
export function useWorkspaceLifecycle({
  state,
  setState,
  settings,
  persistedHint,
  setError,
}: UseWorkspaceLifecycleParams): WorkspaceLifecycle {
  const [loading, setLoading] = useState(false);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [toast, setToast] = useState<{ title: string; description?: string } | null>(null);
  const [fileTree, setFileTree] = useState<FileNode[]>([]);

  const manifestAdapterRef = useRef<ManifestSource | null>(null);
  const workspaceAdapterRef = useRef<WorkspaceAdapter | null>(null);
  const autoRestoredRef = useRef(false);
  const remoteImportRef = useRef(false);
  // Set while the overwrite dialog is closing because the user confirmed, so
  // the close handler can skip the cancel fallback.
  const confirmingRef = useRef(false);

  // Persists a resolved remote-open plan into the virtual workspace, loads it,
  // and makes the root the active module. Does not manage the `loading` flag —
  // callers do.
  async function finishRemoteImport(
    adapter: ManifestSource & WorkspaceAdapter,
    plan: RemoteImportPlan,
  ) {
    await writeRemoteImportPlan(adapter, plan);
    manifestAdapterRef.current = adapter;
    workspaceAdapterRef.current = adapter;
    const workspace = await loadWorkspace(
      VIRTUAL_WORKSPACE_ROOT,
      adapter,
      adapter,
      createRegistryAdapters(settings),
    );
    setState({
      ...INITIAL_STATE,
      workspace,
      activeModulePath: plan.rootDestPath,
      openTabs: [{ type: "module", path: plan.rootDestPath }],
      activeTabId: plan.rootDestPath,
      graphContext: defaultGraphContext(workspace, plan.rootDestPath),
      deploymentsByApp: loadDeploymentsForWorkspace(VIRTUAL_WORKSPACE_ROOT),
    });
    const depCount = plan.files.length - 1;
    setToast({
      title: "Imported into workspace",
      description:
        depCount > 0
          ? `${plan.name} and ${depCount} dependenc${depCount === 1 ? "y" : "ies"} added.`
          : `${plan.name} is now editable locally.`,
    });
  }

  // Re-attaches the last workspace from the persisted hint (Tauri filesystem /
  // browser localStorage). Shared by the mount-time auto-restore and the
  // overwrite-cancel fallback. `shouldAbort` lets the mount effect bail if it
  // unmounts mid-load.
  // Fetches the workspace's external dependency graphs in the background and
  // folds them into the live workspace (which was rendered with local modules
  // only). Guards entirely on the functional setState — the merge runs only if
  // the same workspace is still open and still awaiting deps — rather than on a
  // restore-effect `shouldAbort` flag, which flips `true` the moment the first
  // `setState` re-triggers that effect (it would otherwise strand the workspace
  // on `dependenciesPending` forever). Local edits made during the fetch are
  // preserved — the merge keeps `current` modules and only adds dep modules. On
  // failure the pending flag is cleared so analysis runs and surfaces the
  // genuine unresolved-import errors.
  function enrichWorkspaceDependencies(
    base: Workspace,
    manifestAdapter: ManifestSource,
    workspaceAdapter: WorkspaceAdapter,
    registryAdapters: ManifestSource[],
  ) {
    loadWorkspaceDependencies(base, manifestAdapter, workspaceAdapter, registryAdapters)
      .then((deps) => {
        setState((s) => {
          if (
            !s.workspace ||
            s.workspace.rootDir !== base.rootDir ||
            !s.workspace.dependenciesPending
          ) {
            return s;
          }
          return { ...s, workspace: mergeWorkspaceDependencies(s.workspace, deps, manifestAdapter) };
        });
      })
      .catch((err) => {
        console.error("Failed to load workspace dependencies:", err);
        setState((s) =>
          s.workspace && s.workspace.rootDir === base.rootDir && s.workspace.dependenciesPending
            ? { ...s, workspace: { ...s.workspace, dependenciesPending: false } }
            : s,
        );
      });
  }

  async function restoreLastWorkspace(shouldAbort?: () => boolean) {
    if (!persistedHint?.rootDir) return;
    const reopened = reopenWorkspaceAt(persistedHint.rootDir);
    if (!reopened) return;
    manifestAdapterRef.current = reopened.manifestAdapter;
    workspaceAdapterRef.current = reopened.workspaceAdapter;
    const registryAdapters = createRegistryAdapters(settings);
    // Load only the workspace's own modules first (external dependency graphs —
    // by far the slowest, most variable part of the load — are deferred and
    // streamed in below) and walk the file tree in parallel, so the workspace
    // and explorer paint as fast as the local modules can be parsed.
    const [workspace, fileTree] = await Promise.all([
      loadWorkspace(
        reopened.rootDir,
        reopened.manifestAdapter,
        reopened.workspaceAdapter,
        registryAdapters,
        { deferExternalDeps: true },
      ),
      buildFileTree(reopened.rootDir, reopened.workspaceAdapter).catch((err) => {
        console.error("Failed to build file tree:", err);
        return [] as FileNode[];
      }),
    ]);
    if (shouldAbort?.()) return;
    setFileTree(fileTree);
    enrichWorkspaceDependencies(
      workspace,
      reopened.manifestAdapter,
      reopened.workspaceAdapter,
      registryAdapters,
    );
    const nextActiveModulePath =
      persistedHint.activeModulePath && workspace.modules.has(persistedHint.activeModulePath)
        ? persistedHint.activeModulePath
        : pickInitialActiveModule(workspace);
    const nextActiveModule = nextActiveModulePath
      ? workspace.modules.get(nextActiveModulePath)
      : null;
    // Deployment view only makes sense for Applications; if the persisted view
    // is "deployment" and the active module is a Library, fall back to topology.
    const persistedView = persistedHint.activeView;
    const nextActiveView: ViewId =
      persistedView === "deployment" && nextActiveModule?.kind !== "Application"
        ? "topology"
        : (persistedView ?? "topology");
    const { openTabs, activeTabId } = restoreTabs(
      workspace,
      { openTabs: persistedHint.openTabs, activeTabId: persistedHint.activeTabId },
      nextActiveModulePath,
    );
    setState((s) => ({
      ...s,
      workspace,
      activeModulePath: nextActiveModulePath,
      activeView: nextActiveView,
      openTabs,
      activeTabId,
      expandedDirs: persistedHint.expandedDirs,
      graphContext: defaultGraphContext(workspace, nextActiveModulePath),
      deploymentsByApp: loadDeploymentsForWorkspace(reopened.rootDir),
    }));
  }

  // "Open in Telo Editor": when launched with `?open=<url>`, resolve the
  // manifest and its same-origin relative cascade into an import plan and
  // always surface it for confirmation before persisting. Takes precedence
  // over the silent auto-restore below. Runs once per mount.
  useEffect(() => {
    if (remoteImportRef.current) return;
    const url = readManifestUrlParam(window.location.search);
    if (!url) return;
    remoteImportRef.current = true;
    autoRestoredRef.current = true;
    clearManifestUrlParam();
    setError(null);
    setLoading(true);
    let cancelled = false;
    (async () => {
      try {
        const adapter = createVirtualWorkspaceAdapter();
        const plan = await buildRemoteImportPlan(url, adapter, createRegistryAdapters(settings));
        if (!cancelled) setPendingImport({ adapter, plan });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs once on mount; the guard ref prevents re-import on settings changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-restore the last workspace on mount, when the environment allows
  // re-attaching without a user gesture (Tauri filesystem, browser localStorage).
  // FSA can't silently re-attach — user sees the recent rootDir hint instead.
  useEffect(() => {
    if (autoRestoredRef.current) return;
    if (!persistedHint?.rootDir) return;
    if (state.workspace) return;
    autoRestoredRef.current = true;
    let cancelled = false;
    restoreLastWorkspace(() => cancelled).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedHint, state.workspace, settings, setState]);

  // Rebuild the raw file tree when the workspace root changes (open / restore /
  // remote-import). Keyed on rootDir, not the workspace object, so the common
  // case of an in-place edit producing a new workspace object doesn't trigger a
  // full disk re-walk on every keystroke. Structural file ops refresh the tree
  // explicitly via `refreshFileTree`.
  useEffect(() => {
    const ws = state.workspace;
    const adapter = workspaceAdapterRef.current;
    if (!ws || !adapter) {
      setFileTree([]);
      return;
    }
    let cancelled = false;
    buildFileTree(ws.rootDir, adapter)
      .then((tree) => {
        if (cancelled) return;
        setFileTree(tree);
        // Expand the top-level directories by default — but only when nothing is
        // already expanded, so a restored (or user-collapsed) tree is preserved.
        setState((s) => {
          if (s.expandedDirs.length > 0) return s;
          const topDirs = tree.filter((n) => n.isDirectory).map((n) => n.path);
          return topDirs.length ? { ...s, expandedDirs: topDirs } : s;
        });
      })
      .catch((err) => console.error("Failed to build file tree:", err));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.workspace?.rootDir]);

  // Keep the source-view completion provider's side-channel refs in sync with
  // the current workspace adapter + settings. The provider needs the
  // WorkspaceAdapter (to list directories for relative-path completion) and
  // the registry server list (to fan out search/version queries). Both are
  // ambient at the time a completion request fires — refs avoid re-registering
  // the Monaco provider on every workspace/settings change.
  useEffect(() => {
    setActiveWorkspaceAdapter(workspaceAdapterRef.current ?? undefined);
    setActiveSettings(settings);
  }, [state.workspace, settings]);

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
      const initialActivePath = pickInitialActiveModule(workspace);
      setState({
        ...INITIAL_STATE,
        workspace,
        activeModulePath: initialActivePath,
        openTabs: initialActivePath ? [{ type: "module", path: initialActivePath }] : [],
        activeTabId: initialActivePath,
        graphContext: defaultGraphContext(workspace, initialActivePath),
        deploymentsByApp: loadDeploymentsForWorkspace(opened.rootDir),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirmImport() {
    const pending = pendingImport;
    if (!pending) return;
    confirmingRef.current = true;
    setPendingImport(null);
    setError(null);
    setLoading(true);
    try {
      await finishRemoteImport(pending.adapter, pending.plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  // User declined the import (Cancel / Escape). Abort and fall
  // back to the last workspace the remote-import flow suppressed, so the editor
  // isn't left empty when one was restorable.
  function cancelRemoteImport() {
    setPendingImport(null);
    if (state.workspace) return;
    setLoading(true);
    restoreLastWorkspace()
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }

  function onImportDialogOpenChange(open: boolean) {
    if (open) return;
    if (confirmingRef.current) {
      confirmingRef.current = false;
      setPendingImport(null);
      return;
    }
    cancelRemoteImport();
  }

  /** Rebuilds the explorer tree from disk. Called after file ops (which mutate
   *  disk without necessarily changing the workspace object). */
  async function refreshFileTree(ws?: Workspace | null) {
    const workspace = ws ?? state.workspace;
    const adapter = workspaceAdapterRef.current;
    if (!workspace || !adapter) return;
    try {
      setFileTree(await buildFileTree(workspace.rootDir, adapter));
    } catch (err) {
      console.error("Failed to build file tree:", err);
    }
  }

  /** Re-scans + re-parses the workspace from disk. Run after a file op that can
   *  change telo structure (a telo.yaml or included partial created / deleted /
   *  renamed) so the Applications/Libraries view stays in sync. */
  async function reloadWorkspace(): Promise<Workspace | null> {
    const ws = state.workspace;
    const adapter = workspaceAdapterRef.current;
    const manifestAdapter = manifestAdapterRef.current;
    if (!ws || !adapter || !manifestAdapter) return null;
    return loadWorkspace(ws.rootDir, manifestAdapter, adapter, createRegistryAdapters(settings));
  }

  // After a file op: reload + re-parse the workspace only when one of the
  // `affected` paths could change module structure (a telo.yaml, or a tracked
  // module file); otherwise just rebuild the explorer tree. Avoids a full
  // scanWorkspace on every non-telo create/rename/delete.
  async function afterFileMutation(affected: string[]) {
    const ws = state.workspace;
    const structural = !!ws && affected.some((p) => affectsModuleStructure(ws, p));
    try {
      if (structural) {
        const reloaded = await reloadWorkspace();
        if (reloaded) setState((s) => reconcileWorkspaceTabs(s, reloaded));
        await refreshFileTree(reloaded);
      } else {
        await refreshFileTree();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return {
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
  };
}
