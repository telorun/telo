import { makeTaggedSentinel } from "@telorun/templating";
import { suggestedResourceName } from "../resource-naming";
import { planInlineExtraction, planReferenceInlining } from "../inline-extraction";
import { concretePathToPointer } from "../lib/concrete-path";
import { readPointer } from "../lib/json-pointer";
import { parseRefValue } from "./resource-schema-form/ref-candidates";
import { ReferencesBlockedDialog } from "./views/topology/ReferencesBlockedDialog";
import { File as FileIcon, Lock } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isModuleRootKind, moduleRootResource } from "../application-adapter";
import { analyzeWorkspace } from "../analysis";
import { HistoryManager } from "../history/manager";
import { LocalStorageHistoryStore } from "../history/store";
import { useEditorPersistence } from "../hooks/useEditorPersistence";
import { useImportOps } from "../hooks/useImportOps";
import { useWorkspaceLifecycle } from "../hooks/useWorkspaceLifecycle";
import { INITIAL_STATE, pickInitialActiveModule } from "../editor-state";
import { findResourceReferences, type ResourceReference } from "../resource-references";
import {
  createRegistryAdapters,
  createResourceViaAst,
  deleteModule,
  getImportableLibraries,
  hasUnresolvedImports,
  loadWorkspace,
  noopAdapter,
  normalizePath,
  isWorkspaceModule,
  persistWorkspaceModule,
  rebuildManifestFromDocuments,
  reconcileImports,
  removeResourceViaAst,
  resolveTemplatesBaseUrl,
  renameResourceFieldKey,
  moveResourceFieldItem,
  relocateResourceFieldItem,
  removeResourceFieldItem,
  setModuleRootFields,
  setResourceFields,
  VIRTUAL_WORKSPACE_ROOT,
  workspaceOpenMode,
} from "../loader";
import { pathBasename, pathDirname, pathJoin } from "../loader/paths";
import { moduleParseError, parseModuleDocument } from "../yaml-document";
import type { CanvasViewport, ModuleDocument, ParsedManifest } from "../model";
import type {
  EditorState,
  ModuleKind,
  ModuleTopologyState,
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
import { resolveDeclaredPorts } from "./views/run/declared-ports";
import {
  buildRunBundle,
  bundleFiles,
  diffBundle,
  isEmptyChangeSet,
  registry as runRegistry,
  selectModuleFiles,
  SessionGoneError,
  TermsRequiredError,
  useRun,
  type SyncedFiles,
} from "../run";
import type { RunnerCapabilities, RunnerTerms } from "../run";
import { useAgent } from "../agent";
import type { WorkspaceBridge } from "../agent";
import { sessionWorkspace } from "../agent/agent-workspace";
import { sha256Hex } from "../agent/hash";
import { AGENT_APP_NAME } from "../agent/launch";
import { SYNC_EXCLUDED_DIRS } from "../agent/sync";
import { AgentPanel } from "./agent/AgentPanel";
import { saveDeploymentsForWorkspace } from "../storage-deployments";
import { findMissingRequiredEnv } from "./views/run/declared-env";
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
import { CreateModuleDialog } from "./CreateModuleDialog";
import { CreateResourceModal } from "./CreateResourceModal";
import { EditorTabs } from "./EditorTabs";
import type { TabItem } from "./EditorTabs";
import { FileEditor } from "./views/FileEditor";
import { DiagnosticsProvider } from "./diagnostics/DiagnosticsContext";
import {
  setActiveCurrentPath,
  setActiveDocs,
  setActiveGraph,
  setActiveNavigator,
  setActiveAnalysis,
  setActiveRegistry,
} from "./views/source/provider-state";
import { getModuleFiles } from "../diagnostics-aggregate";
import { SettingsModal } from "./SettingsModal";
import { Sidebar } from "./sidebar/Sidebar";
import { TermsGateDialog } from "./TermsGateDialog";
import { TopBar } from "./TopBar";
import { acceptTermsFor, isTermsAcceptedFor } from "../storage";
import { ViewContainer } from "./views/ViewContainer";
import type { RefWrite } from "./views/topology/application-canvas-model";
import { leafConcreteIndex, writeConcretePath } from "../lib/concrete-path";
import type { Range, ZoneExportCache } from "@telorun/analyzer";

/** A module the user has not navigated inside yet: the containment root, no
 *  per-view state. Frozen so the shared default can never be mutated into a
 *  cross-module leak. */
const EMPTY_MODULE_TOPOLOGY: ModuleTopologyState = Object.freeze({
  focusPath: [] as string[],
  focusRequest: null,
  viewState: Object.freeze({}) as Record<string, unknown>,
});


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
    s.activeView === "run" && nextModule?.kind !== "Application"
      ? "topology"
      : s.activeView;
  return {
    ...s,
    activeModulePath: filePath,
    activeView,
    openTabs: upsertTab(s.openTabs, { type: "module", path: filePath }),
    activeTabId: filePath,
    selectedResource: moduleChanged ? null : s.selectedResource,
    panelStack: moduleChanged ? [] : s.panelStack,
  };
}

/** The base a generated resource name is derived from (`Ai.Tools` → `tools`).
 *
 *  Case encodes what a name DENOTES: a resource instance is a VALUE, so it is
 *  camelCase, and only a `Telo.Type` — a named shape with no runtime instance —
 *  is type-level and stays PascalCase. Generating the kind name verbatim wrote a
 *  name `telo check` warns about (`NAME_CASE_CONVENTION`) the moment it landed.
 *  Only the first character moves, which is also all the rule checks: the rest
 *  may be an acronym (`SQL`, `AI`) that lowercasing whole would mangle.
 */
/** Why a resource cannot be folded into the slot naming it, when the reason is
 *  not another reference. Null when there is none. */
function inlineRefusal(manifest: ParsedManifest, name: string): string | null {
  // A library's exported instance is public surface: importers name it, and
  // this module cannot see whether any of them does.
  const exports = moduleRootResource(manifest).fields.exports as
    | { resources?: unknown }
    | undefined;
  const exported = Array.isArray(exports?.resources) && exports.resources.includes(name);
  if (exported) {
    return `'${name}' is listed in exports.resources, so importers reach it by name. Remove the export first — an inline declaration has no name to be exported under.`;
  }
  return null;
}

export function Editor() {
  const { state, setState, settings, setSettings, persistedHint } = useEditorPersistence(
    INITIAL_STATE,
    DEFAULT_SETTINGS,
  );
  const runContext = useRun();
  // Whether this environment can offer a CHOICE of workspace. Fixed for the
  // session — it is a property of the host, not of what is open.
  const openMode = workspaceOpenMode();
  const agent = useAgent();
  const agentLocked = agent.locked;
  const agentLockedRef = useRef(agentLocked);
  agentLockedRef.current = agentLocked;
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The pending terms gate: the runner's terms, the runner they belong to, and
  // what to resume once accepted — the run that was blocked, or the agent turn
  // whose launch was refused. Null when no gate is shown.
  const [termsGate, setTermsGate] = useState<{
    terms: RunnerTerms;
    runnerId: string;
    resume: { kind: "run"; filePath: string } | { kind: "agent" };
  } | null>(null);
  const [createResourceOpen, setCreateResourceOpen] = useState(false);
  const [createModuleKind, setCreateModuleKind] = useState<ModuleKind | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  /** Why an inlining was refused — checked on the click rather than to grey a
   *  button out, since the answer is a walk of the whole module and the reason
   *  has to be shown either way. */
  const [inlineBlocked, setInlineBlocked] = useState<{
    name: string;
    references: ResourceReference[];
    reason?: string;
  } | null>(null);

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
    createNewModule,
    handleConfirmImport,
    onImportDialogOpenChange,
    refreshFileTree,
    afterFileMutation,
  } = useWorkspaceLifecycle({ state, setState, settings, persistedHint, setError });

  // Bridge the editor's workspace to the authoring agent: content-hash the tree
  // for two-way sync, and reflect the agent's writes back through the same
  // WorkspaceAdapter + afterFileMutation the manual editors use. One conversation
  // per workspace, keyed by rootDir.
  const agentRootDir = state.workspace?.rootDir ?? null;
  const {
    registerWorkspace: registerAgentWorkspace,
    setConversation: setAgentConversation,
    setRunner: setAgentRunner,
    setCoResidentAgent,
    setRunnerAcceptedTerms: setAgentRunnerTerms,
    registerTermsGate: registerAgentTermsGate,
    retry: agentRetry,
  } = agent;
  const workspaceBridge = useMemo<WorkspaceBridge | null>(() => {
    if (!agentRootDir) return null;
    const abs = (rel: string) => (rel ? pathJoin(agentRootDir, rel) : agentRootDir);
    return {
      async snapshot() {
        const adapter = workspaceAdapterRef.current;
        const out = new Map<string, string>();
        if (!adapter) return out;
        const walk = async (rel: string) => {
          for (const entry of await adapter.listDir(abs(rel))) {
            if (SYNC_EXCLUDED_DIRS.has(entry.name)) continue;
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory) await walk(childRel);
            else out.set(childRel, await sha256Hex(await adapter.readFile(abs(childRel))));
          }
        };
        await walk("");
        return out;
      },
      async readFile(rel) {
        const adapter = workspaceAdapterRef.current;
        if (!adapter) throw new Error("no workspace open");
        return adapter.readFile(abs(rel));
      },
      async applyChanges(writes, deletes) {
        const adapter = workspaceAdapterRef.current;
        if (!adapter) return;
        const affected: string[] = [];
        for (const w of writes) {
          await adapter.writeFile(abs(w.path), w.content);
          affected.push(abs(w.path));
        }
        for (const d of deletes) {
          try {
            await adapter.delete(abs(d));
            affected.push(abs(d));
          } catch {
            /* already gone */
          }
        }
        if (affected.length) await afterFileMutation(affected);
      },
    };
  }, [agentRootDir, afterFileMutation, workspaceAdapterRef]);

  useEffect(() => {
    registerAgentWorkspace(workspaceBridge);
    return () => registerAgentWorkspace(null);
  }, [registerAgentWorkspace, workspaceBridge]);

  useEffect(() => {
    setAgentConversation(agentRootDir);
  }, [setAgentConversation, agentRootDir]);

  // A terms-enforcing runner refuses the agent launch with the same agreement it
  // refuses a run with, so it gets the same gate: the dialog lives here, and
  // accepting resumes the turn that was blocked.
  useEffect(() => {
    registerAgentTermsGate((terms) =>
      setTermsGate({ terms, runnerId: settings.activeRunnerId, resume: { kind: "agent" } }),
    );
    return () => registerAgentTermsGate(null);
  }, [registerAgentTermsGate, settings.activeRunnerId]);

  // Hand the chat panel the agent riding inside a live watch session, so it
  // talks to that one instead of launching a session of the agent's own. The
  // session's workspace surface comes with it: a co-resident agent writes the
  // shared volume directly, so `/v1/sessions/:id/workspace` — not the agent's
  // own routes — is where the editor sees what it wrote. Null whenever no such
  // session is up, which is what makes the panel fall back to a standalone
  // launch rather than going dead.
  const { coResidentAgent } = runContext;
  useEffect(() => {
    const live = coResidentAgent();
    const workspace = live ? sessionWorkspace(live.session) : null;
    setCoResidentAgent(
      live && workspace ? { runId: live.runId, baseUrl: live.baseUrl, workspace } : null,
    );
  }, [coResidentAgent, setCoResidentAgent]);

  // The active runner is where a per-session agent instance is launched. The
  // agent entry point shows only when the runner offers the authoring agent as
  // a predefined app on /v1/capabilities — the runner resolves the image and
  // injects the operator secrets server-side; the editor only asks by name.
  const [agentSupported, setAgentSupported] = useState(false);
  // The catalog name to request as a watch session's co-resident agent, or null
  // when this runner offers none. A separate capability from `apps` above: that
  // one says the agent can be launched as a session of its own, this one that
  // it may ride inside another session, and an operator can enable either.
  const [coResidentAgentName, setCoResidentAgentName] = useState<string | null>(null);
  useEffect(() => {
    const runner = settings.runners.find((r) => r.id === settings.activeRunnerId);
    const config = runner?.config as { baseUrl?: string } | undefined;
    const adapter = runner ? runRegistry.get(runner.adapterId) : undefined;
    let cancelled = false;
    // The runner's dialable URL isn't always a config field — the local-docker
    // adapter resolves it from its supervisor — so ask the adapter.
    if (adapter?.resolveBaseUrl && runner) {
      adapter
        .resolveBaseUrl(runner.config)
        .then((baseUrl) => {
          if (!cancelled) setAgentRunner(baseUrl);
        })
        .catch(() => {
          if (!cancelled) setAgentRunner(null);
        });
    } else {
      setAgentRunner(config?.baseUrl ?? null);
    }
    setAgentSupported(false);
    setCoResidentAgentName(null);
    setAgentRunnerTerms(null);
    const cancel = () => {
      cancelled = true;
    };
    if (!runner || !adapter?.fetchCapabilities) return cancel;
    adapter
      .fetchCapabilities(runner.config as never)
      .then((caps) => {
        if (cancelled) return;
        setAgentSupported(caps?.apps?.some((a) => a.name === AGENT_APP_NAME) === true);
        setCoResidentAgentName(
          caps?.features?.agents?.includes(AGENT_APP_NAME) ? AGENT_APP_NAME : null,
        );
        // A terms-enforcing runner 428s the agent launch without the accepted
        // version header; the run flow's acceptance (per runner + version)
        // carries over to agent sessions.
        setAgentRunnerTerms(
          caps?.terms && isTermsAcceptedFor(runner.id, caps.terms.version)
            ? caps.terms.version
            : null,
        );
      })
      .catch(() => {
        // Unreachable / malformed — the run UI surfaces the fault; here the
        // app just stays unoffered, hiding the agent entry point.
        if (!cancelled) {
          setAgentSupported(false);
          setCoResidentAgentName(null);
        }
      });
    return cancel;
  }, [setAgentRunner, setAgentRunnerTerms, settings.runners, settings.activeRunnerId]);
  // The dev override URL bypasses the runner entirely, so it keeps the agent
  // reachable (and its settings editable) regardless of the capability. Either
  // capability is enough to offer the panel: a runner may enable the agent as a
  // co-resident only, and hiding the entry point there would make the operator's
  // configuration have no effect.
  const agentVisible =
    agentSupported || coResidentAgentName !== null || agent.overrideUrl.trim() !== "";

  const analysisTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Host-lifetime cache for per-library zone-export derivation. Owned here, not
  // by the per-run AnalysisRegistry: analysis runs on every keystroke and each
  // run builds a fresh registry per closure, so a cache there would rebuild
  // every dependency's call graph each time. Its `(source, content signature)`
  // key makes a workspace library the user is editing invalidate by
  // construction.
  const zoneExportCacheRef = useRef<ZoneExportCache>(new Map());
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
        zoneExportCacheRef.current,
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
    // What CEL sees in this file's closure — built on first use, so opening a
    // file is what pays for it rather than every analysis pass.
    setActiveAnalysis(path ? state.diagnostics.analysisByFile.get(path)?.() : undefined);
    // The loaded graph + active path back go-to-definition (`!ref` → target
    // resource across the module's files).
    setActiveGraph(path ? state.diagnostics.graphByFile.get(path) : undefined);
    setActiveCurrentPath(path ?? undefined);
    // Thread the active file's already-parsed AST so source completion can
    // reuse it instead of re-parsing (the provider guards on text identity).
    const loaded = path ? state.workspace?.documents.get(path)?.loaded : undefined;
    setActiveDocs(loaded ? { text: loaded.text, docs: loaded.astDocuments } : undefined);
  }, [state.diagnostics, state.activeModulePath, state.workspace]);


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

  // Workspace-local libraries the active module can import directly — feeds the
  // Imports view's "Add import" side dropdown.
  const importableLibraries = useMemo(
    () =>
      state.workspace && state.activeModulePath
        ? getImportableLibraries(state.workspace, state.activeModulePath)
        : [],
    [state.workspace, state.activeModulePath],
  );

  // The Application this module pane can run. Everything else about a run —
  // status, history, dock geometry — is keyed by this path inside the run
  // context, so nothing about it is mirrored into editor state.
  const activeAppPath =
    activeManifest?.kind === "Application" ? activeManifest.filePath : null;
  const activeRunnerName =
    settings.runners.find((r) => r.id === settings.activeRunnerId)?.name ?? null;

  // ---------------------------------------------------------------------------
  // Module creation + deletion
  // ---------------------------------------------------------------------------

  async function handleDeleteModule(filePath: string) {
    const workspace = state.workspace;
    const adapter = workspaceAdapterRef.current;
    if (!workspace || !adapter) return;
    const updated = await deleteModule(workspace, filePath, adapter);
    // The run context is keyed by module path, so a deleted module's dock,
    // blocker and selection would outlive it — and be inherited by a module
    // later created at the same path.
    runContext.forgetApp(filePath);
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
        selectedResource: moduleChanged ? null : s.selectedResource,
        panelStack: moduleChanged ? [] : s.panelStack,
      };
    });
    void refreshFileTree(updated);
  }

  /**
   * Start an Application. There is ONE way to run: a watch session, where the
   * app keeps running and a save reloads it. The mode is not a choice the user
   * makes — it is the runner's capability, so a runner (or a docker daemon) too
   * old for watch sessions degrades to a plain run rather than rejecting every
   * Run with a mode it was never offered.
   */
  async function handleRunModule(filePath: string) {
    setError(null);
    // The dock states why the LAST press failed, so it is cleared with the same
    // gesture that clears the error banner. Every early return below reports
    // through `setError` / Settings instead, and a blocker left standing would
    // have the dock name a cause that is not this press's.
    runContext.clearBlocker(filePath);
    // A run lives in its own Application's pane — the dock and the Run tab are
    // that module's. Running one from the sidebar therefore brings it forward,
    // or the output would stream into a pane nobody is looking at.
    if (state.activeModulePath !== filePath) handleOpenModule(filePath);
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
      runContext.showBlocker(filePath, {
        kind: "unavailable",
        adapterId: adapter.id,
        adapterDisplayName: adapter.displayName,
        message: availability.message,
        remediation: availability.remediation,
        action: availability.action,
        recheck: async () => {
          const again = await adapter.isAvailable(config);
          if (again.status === "ready") {
            runContext.clearBlocker(filePath);
            void handleRunModuleRef.current(filePath);
          }
        },
      });
      return;
    }

    // The runner is the authority on two things this run needs: whether an
    // agreement must be accepted first, and whether it can host a watch session.
    // Both are read from one fresh capabilities fetch rather than from the state
    // the header keeps — that state is filled asynchronously, so a Run clicked
    // before it lands would silently start a plain run, which is exactly the
    // difference the single Run control exists to stop the user reasoning about.
    let capabilities: RunnerCapabilities | null = null;
    try {
      capabilities = (await adapter.fetchCapabilities?.(config)) ?? null;
    } catch (err) {
      setError(
        `Failed to read runner capabilities: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const terms: RunnerTerms | null = capabilities?.terms ?? null;
    // A runner too old for watch sessions — or a docker runner on a daemon that
    // cannot scope a mount — degrades to a plain run rather than having every
    // Run rejected for a mode it never offered.
    const mode: "run" | "watch" = capabilities?.features?.watch === true ? "watch" : "run";
    // From the SAME fetch, for the same reason: read from the header's state and
    // a Run clicked before it lands starts a watch session with no agent, and
    // the panel quietly launches a standalone one instead.
    const agentName = capabilities?.features?.agents?.includes(AGENT_APP_NAME)
      ? AGENT_APP_NAME
      : null;
    if (terms && !isTermsAcceptedFor(runner.id, terms.version)) {
      setTermsGate({ terms, runnerId: runner.id, resume: { kind: "run", filePath } });
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
      runContext.showBlocker(filePath, {
        kind: "missing-config",
        entries: missing.map((entry) => ({
          name: entry.name,
          envVar: entry.envVar,
          secret: entry.secret,
        })),
      });
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
          mode,
          // A watch session is where the authoring agent belongs: co-resident,
          // it writes the very volume these containers watch, so its edits
          // reload the app the user is looking at. Requested whenever the
          // runner offers one, rather than when the chat panel happens to be
          // open — an agent that depends on panel state at start time would
          // make one button mean two things, and a session's container set is
          // fixed once it is created.
          ...(mode === "watch" && agentName ? { agent: agentName } : {}),
        },
      });
      if (mode === "watch") {
        // The bundle we just sent IS the workspace's contents, so the first
        // diff after this is exactly the user's next edit.
        syncedFilesRef.current.set(filePath, bundleFiles(bundle));
      }
    } catch (err) {
      // Safety net: the runner enforces terms server-side, so even if the gate
      // was skipped (e.g. the version changed since we fetched it) it can reject
      // with the current terms — surface the gate and let the user retry.
      if (err instanceof TermsRequiredError) {
        setTermsGate({ terms: err.terms, runnerId: runner.id, resume: { kind: "run", filePath } });
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
  // What the editor last pushed into each app's live watch workspace, by app
  // path. Diffing against it is what keeps a save from reloading every app: the
  // kernel's watcher fires on a write, so an unconditional re-push would reload
  // apps that never read the saved file.
  const syncedFilesRef = useRef<Map<string, SyncedFiles>>(new Map());
  // One in-flight sync per app. Two rapid saves must not interleave writes into
  // one workspace, and the later one must still land.
  const syncQueueRef = useRef<Map<string, Promise<void>>>(new Map());

  /** Push what changed into every live watch session, after a save. A no-op when
   *  the app has no watch session, so the save path calls it unconditionally. */
  function syncWatchSessions(workspace: Workspace): void {
    const adapter = workspaceAdapterRef.current;
    if (!adapter) return;
    const live = runContext.watchRuns();
    const liveApps = new Set(live.map((r) => r.appPath));
    for (const appPath of [...syncedFilesRef.current.keys()]) {
      // The session ended — drop the snapshot so a later one starts clean.
      if (!liveApps.has(appPath)) syncedFilesRef.current.delete(appPath);
    }
    for (const run of live) {
      const appPath = run.appPath;
      const queued = (syncQueueRef.current.get(appPath) ?? Promise.resolve()).then(async () => {
        // No snapshot means this session was re-attached after a page reload, so
        // what the workspace holds is unknown: push everything once and diff from
        // there. Costs one extra reload after a refresh; the alternative is a
        // refreshed tab silently disconnecting saves from a running workspace.
        const previous = syncedFilesRef.current.get(appPath) ?? new Map<string, string>();
        const bundle = await buildRunBundle(
          workspace,
          appPath,
          (p) => adapter.readFile(p),
          (base, patterns) => selectModuleFiles(base, patterns, (dir) => adapter.listDir(dir)),
        );
        const next = bundleFiles(bundle);
        const changes = diffBundle(previous, next);
        if (isEmptyChangeSet(changes)) return;
        await runContext.syncWorkspace(run.id, changes);
        // Recorded only AFTER the write lands: a failed sync must re-send on the
        // next save rather than believing the workspace already has the edit.
        syncedFilesRef.current.set(appPath, next);
      });
      syncQueueRef.current.set(
        appPath,
        queued.catch((err) => {
          // The runner lost the session (a restart drops every checkpoint). The
          // editor holds the authoritative workspace, so the remedy is to run
          // again — say that instead of a wire error the user cannot act on.
          if (err instanceof SessionGoneError) {
            syncedFilesRef.current.delete(appPath);
            setError(
              "The runner no longer holds this watch session — run it again to start a fresh one.",
            );
            return;
          }
          setError(
            `Failed to sync the running workspace: ${err instanceof Error ? err.message : String(err)}`,
          );
        }),
      );
    }
  }

  async function persistModule(
    workspace: Workspace,
    filePath: string,
    opts?: { skipHistory?: boolean },
  ): Promise<Workspace> {
    const adapter = workspaceAdapterRef.current;
    if (!adapter) return workspace;
    // Single chokepoint for every manifest write (form edits, source edits,
    // undo/redo, import ops): while an agent turn holds the workspace, nothing
    // may land — a mid-turn write isn't in the agent's seeded tree and the
    // end-of-turn reconcile would silently revert it.
    if (agentLockedRef.current) {
      setError("Editing is paused while the agent is working.");
      return workspace;
    }

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

    // Every manifest write funnels through here, which is exactly where a live
    // watch workspace has to learn about it.
    syncWatchSessions(next);

    return next;
  }

  // Import authoring for the active module — add / remove / upgrade.
  const { handleAddImport, handleRemoveImport, handleUpgradeImport, handleUpgradeAllImports } =
    useImportOps({ state, setState, settings, manifestAdapterRef, persistModule });

  // ---------------------------------------------------------------------------
  // Navigation (direct set, no stack)
  // ---------------------------------------------------------------------------

  function handleOpenModule(filePath: string) {
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
  const saveFileCb = useCallback((p: string, text: string) => {
    if (agentLockedRef.current) {
      return Promise.reject(new Error("Editing is paused while the agent is working."));
    }
    return workspaceAdapterRef.current!.writeFile(p, text);
  }, []);

  async function handleCreateFile(parentDir: string, name: string) {
    if (agentLocked) return;
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
    if (agentLocked) return;
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
    if (agentLocked) return;
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
    if (agentLocked) return;
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
    if (agentLocked) return;
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

  // A viewport belongs to a module AND to the view + level it was framed in —
  // see `EditorState.viewportByModule`.
  function handleCanvasViewportChange(key: string, viewport: CanvasViewport) {
    setState((s) =>
      s.activeModulePath
        ? {
            ...s,
            viewportByModule: { ...s.viewportByModule, [`${s.activeModulePath}#${key}`]: viewport },
          }
        : s,
    );
  }

  function updateModuleTopology(
    s: EditorState,
    update: (prev: ModuleTopologyState) => ModuleTopologyState,
  ): EditorState {
    if (!s.activeModulePath) return s;
    const prev = s.topologyByModule[s.activeModulePath] ?? EMPTY_MODULE_TOPOLOGY;
    return {
      ...s,
      topologyByModule: { ...s.topologyByModule, [s.activeModulePath]: update(prev) },
    };
  }

  // Taking a route consumes any pending request for one — the host resolves a
  // request by calling this, so clearing it here is what stops it re-firing on
  // every pass and dragging the user back out of wherever they went next.
  function handleFocusPath(focusPath: string[]) {
    setState((s) =>
      updateModuleTopology(s, (prev) => ({ ...prev, focusPath, focusRequest: null })),
    );
  }

  function handleTopologyViewState(viewId: string, next: unknown) {
    setState((s) =>
      updateModuleTopology(s, (prev) => ({
        ...prev,
        viewState: { ...prev.viewState, [viewId]: next },
      })),
    );
  }

  function handlePickTopologyView(choiceKey: string, viewId: string) {
    setSettings({
      ...settings,
      topologyViewByChoiceKey: { ...(settings.topologyViewByChoiceKey ?? {}), [choiceKey]: viewId },
    });
  }

  /** Navigate the topology view to a resource named from another tab. Only the
   *  topology host holds the containment tree, so what is recorded here is the
   *  NAME; the host resolves it to a focus path on its next pass. */
  function handleNavigateResource(kind: string, name: string) {
    setSelection(null);
    setState((s) =>
      updateModuleTopology(
        {
          ...s,
          activeView: "topology" as ViewId,
          selectedResource: { kind, name },
          panelStack: [{ type: "resource", kind, name }],
        },
        (prev) => ({ ...prev, focusRequest: name }),
      ),
    );
  }

  const revealNonceRef = useRef(0);
  const navigateToDiagnostic = useCallback(
    (filePath: string, range?: Range) => {
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
    },
    [state.workspace, state.activeModulePath],
  );

  // Bridge cross-file go-to-definition into the app's navigation. Depends on the
  // memoized callback, so it re-registers only when the closed-over state changes.
  useEffect(() => {
    setActiveNavigator(navigateToDiagnostic);
  }, [navigateToDiagnostic]);

  // ---------------------------------------------------------------------------
  // Resource creation
  // ---------------------------------------------------------------------------

  // Memoized because its identity is the root of a chain: the canvas model
  // hangs off it, the containment tree off that, and the nested view's layout —
  // one dagre pass per lane per expanded container, recursively — off that. Left
  // unmemoized, every keystroke, hover and streamed run-output chunk re-ran the
  // lot, since a fresh `viewData` object defeats every `useMemo` below it.
  const viewData = useMemo(
    () =>
      state.workspace && activeManifest
        ? buildModuleViewData(state.workspace, activeManifest)
        : null,
    [state.workspace, activeManifest],
  );

  const availableKinds = viewData ? [...viewData.kinds.values()] : [];

  const activeTopology = state.activeModulePath
    ? (state.topologyByModule[state.activeModulePath] ?? EMPTY_MODULE_TOPOLOGY)
    : EMPTY_MODULE_TOPOLOGY;

  // A remote/imported (non-workspace) module has no editable on-disk file, so
  // it opens read-only across every view.
  const activeIsRemote =
    !!state.workspace &&
    !!state.activeModulePath &&
    !isWorkspaceModule(state.workspace, state.activeModulePath);
  // Single source of truth for the read-only state; `readOnly` is derived from
  // it so the two view props can never drift.
  const readOnlyReason: "agent" | "remote" | null = agentLocked
    ? "agent"
    : activeIsRemote
      ? "remote"
      : null;

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

  /** Creates an empty resource of `kind` under a generated name — the one-click
   *  path the module bar's import rows offer, where the kind is already chosen
   *  and a modal would only ask for a name. Same de-duplication as create-and-
   *  link, so the two surfaces cannot generate colliding names. */
  async function handleCreateResourceOfKind(kind: string) {
    if (!state.workspace || !state.activeModulePath) return;
    const manifest = state.workspace.modules.get(state.activeModulePath);
    await handleCreateResource(kind, uniqueResourceName(manifest, kind), {});
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
    // The root is the one resource carrying the inline `imports:` map, whose
    // shorthand entries have to be widened before a nested write lands.
    const write = isModuleRootKind(kind) ? setModuleRootFields : setResourceFields;
    const updated = write(
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

    // Ref slots only: a CEL read is an expression, and there is no value to
    // write null into. Deleting from the canvas therefore still leaves a CEL
    // read dangling — which the root level's delete refuses over, and which the
    // analyzer reports either way.
    const writes: RefWrite[] = findResourceReferences(registry, manifest, deleted)
      .filter((ref) => ref.via === "ref")
      .map((ref) => ({ source: ref.source, concretePath: ref.path, target: null }));
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

  // A resource name derived from a kind, de-duplicated against existing
  // resources so a fresh create never collides. The kind's capability decides
  // the case, so the lookup runs against the active module's own kind table.
  function uniqueResourceName(
    manifest: { resources: { name: string }[] } | undefined,
    kind: string,
  ): string {
    return suggestedResourceName(
      kind,
      viewData?.kinds.get(kind)?.capability,
      (manifest?.resources ?? []).map((r) => r.name),
    );
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

  /** Create-and-link from a form's ref picker: the new resource and the slot
   *  that points at it land in ONE workspace, so neither persist can read a
   *  snapshot taken before the other. The canvas's `RefWrite.createKind` does
   *  the same thing from a concrete path; this does it from the whole next
   *  fields object, which is what a form has. */
  async function handleCreateAndLink(
    target: { kind: string; name: string },
    createKind: string,
    buildFields: (newName: string) => Record<string, unknown>,
  ) {
    if (!state.workspace || !state.activeModulePath) return;
    const modulePath = state.activeModulePath;
    const manifest = state.workspace.modules.get(modulePath);
    if (!manifest) return;
    const prev =
      manifest.resources.find((r) => r.kind === target.kind && r.name === target.name) ??
      (isModuleRootKind(target.kind) ? moduleRootResource(manifest) : undefined);
    if (!prev) return;

    const name = uniqueResourceName(manifest, createKind);
    let ws = createResourceViaAst(state.workspace, modulePath, createKind, name, {});
    ws = setResourceFields(ws, modulePath, target.kind, target.name, prev.fields, buildFields(name));
    const persisted = await persistModule(ws, modulePath);
    setState((s) => ({ ...s, workspace: persisted }));
    // Land in the new resource's own form — it was created empty, and its
    // required fields are the reason the slot was unfillable a moment ago.
    handleSelectResource(createKind, name);
  }

  /**
   * Moves a resource declared inline at `pointer` into its own document, and
   * leaves a reference to it in the slot.
   *
   * ONE workspace mutation, for the reason create-and-link is one: two would
   * race, and a half-applied extraction is either a resource declared twice or
   * a slot pointing at nothing. `kind` moves to the document's own `kind:` and
   * `metadata` is replaced by the new name, so neither is carried into the
   * config; every other key travels verbatim, nested inline declarations
   * included — extracting one level does not flatten what is inside it.
   */
  async function handleExtractInline(
    host: { kind: string; name: string },
    pointer: string,
    name: string,
  ) {
    if (!state.workspace || !state.activeModulePath) return;
    const modulePath = state.activeModulePath;
    const manifest = state.workspace.modules.get(modulePath);
    if (!manifest) return;
    const prev =
      manifest.resources.find((r) => r.kind === host.kind && r.name === host.name) ??
      (isModuleRootKind(host.kind) ? moduleRootResource(manifest) : undefined);
    if (!prev) return;

    const plan = planInlineExtraction(prev.fields, pointer, name);
    if (!plan) return;

    let ws = createResourceViaAst(state.workspace, modulePath, plan.kind, name, plan.config);
    ws = setResourceFields(ws, modulePath, host.kind, host.name, prev.fields, plan.hostFields);
    const persisted = await persistModule(ws, modulePath);
    setState((s) => ({ ...s, workspace: persisted }));
    // Land in the extracted resource: it is what the user just named, and the
    // slot they were in now says only that it points here.
    handleSelectResource(plan.kind, name);
  }

  /**
   * Moves the resource referenced at `pointer` back into that slot, and removes
   * the document it was declared in.
   *
   * The inverse of {@link handleExtractInline}, refused unless the slot is the
   * ONLY place the resource is named: a declaration lives where it is written,
   * so a second reference has nowhere to point once the document is gone. The
   * refusal names what still holds it, which is what makes "clear them first"
   * something the user can act on — the arrangement `handleDeleteResource`
   * already takes, and for the same reason.
   *
   * `targets:` is a ref-only slot, so an entry there is a blocker rather than a
   * host: inlining into one would produce a boot list the loader rejects.
   */
  async function handleInlineReference(host: { kind: string; name: string }, pointer: string) {
    if (!state.workspace || !state.activeModulePath) return;
    const modulePath = state.activeModulePath;
    const manifest = state.workspace.modules.get(modulePath);
    if (!manifest) return;
    const prev =
      manifest.resources.find((r) => r.kind === host.kind && r.name === host.name) ??
      (isModuleRootKind(host.kind) ? moduleRootResource(manifest) : undefined);
    if (!prev) return;

    const name = parseRefValue(readPointer(prev.fields, pointer));
    if (!name) return;
    // The root's only ref slots are its boot `targets:`, which the loader
    // accepts as references and nothing else — a declaration written there is
    // not a shorter spelling of the same thing, it is a manifest that fails.
    if (isModuleRootKind(host.kind)) {
      setInlineBlocked({
        name,
        references: [],
        reason: `Boot targets name a resource — a declaration cannot be written in one, so '${name}' has to stay a document of its own.`,
      });
      return;
    }
    const target = manifest.resources.find((r) => r.name === name);
    // A reference across an import boundary names a resource this module does
    // not declare, so there is no document to move.
    if (!target) {
      setInlineBlocked({
        name,
        references: [],
        reason: `'${name}' is declared by an imported library, so this module has no document to move.`,
      });
      return;
    }

    // No registry means the reference set is UNKNOWN, not empty — the one input
    // on which reading it as empty would delete a resource unchecked.
    const registry = state.diagnostics.registryByFile.get(modulePath);
    if (!registry) {
      setInlineBlocked({ name, references: [] });
      return;
    }
    const refusal = inlineRefusal(manifest, name);
    if (refusal) {
      setInlineBlocked({ name, references: [], reason: refusal });
      return;
    }
    const elsewhere = findResourceReferences(registry, manifest, name).filter(
      (ref) =>
        !(
          ref.via === "ref" &&
          ref.source.kind === host.kind &&
          ref.source.name === host.name &&
          concretePathToPointer(ref.path) === pointer
        ),
    );
    if (elsewhere.length > 0) {
      setInlineBlocked({ name, references: elsewhere });
      return;
    }

    const plan = planReferenceInlining(prev.fields, pointer, {
      kind: target.kind,
      name: target.name,
      fields: target.fields,
    });
    if (!plan) return;

    // ONE workspace mutation, as the extraction is: two would race, and a
    // half-applied move is either a declaration in two places or a slot
    // pointing at nothing.
    let ws = setResourceFields(
      state.workspace,
      modulePath,
      host.kind,
      host.name,
      prev.fields,
      plan.hostFields,
    );
    ws = removeResourceViaAst(ws, modulePath, target.kind, target.name);
    const persisted = await persistModule(ws, modulePath);
    setState((s) => ({ ...s, workspace: persisted }));
    // Land on the slot the declaration now lives in — the resource that held it
    // no longer exists under its own name.
    handleSelectResource(host.kind, host.name);
    setSelection({
      resource: host,
      pointer,
      schema: viewData?.kinds.get(target.kind)?.schema ?? {},
    });
  }

  /** Reorders one item of a sequence field — its own AST op, since a field diff
   *  is positional and would rewrite every entry it passed over. */
  async function handleMoveField(
    target: { kind: string; name: string },
    pointer: string,
    toIndex: number,
  ) {
    if (!state.workspace || !state.activeModulePath) return;
    const updated = moveResourceFieldItem(
      state.workspace,
      state.activeModulePath,
      target.kind,
      target.name,
      pointer,
      toIndex,
    );
    if (updated === state.workspace) return;
    const persisted = await persistModule(updated, state.activeModulePath);
    setState((s) => ({ ...s, workspace: persisted }));
  }

  /** Moves one item of a sequence field into a different sequence of the same
   *  resource — a step dragged between branches. Its own AST op, since a remove
   *  plus an insert would re-serialize the step at its destination. */
  async function handleRelocateField(
    target: { kind: string; name: string },
    pointer: string,
    toPointer: string,
    toIndex: number,
  ) {
    if (!state.workspace || !state.activeModulePath) return;
    const updated = relocateResourceFieldItem(
      state.workspace,
      state.activeModulePath,
      target.kind,
      target.name,
      pointer,
      toPointer,
      toIndex,
    );
    if (updated === state.workspace) return;
    const persisted = await persistModule(updated, state.activeModulePath);
    setState((s) => ({ ...s, workspace: persisted }));
  }

  /** Removes one item of a sequence field — its own AST op, since a field diff
   *  would write the survivors' values over the wrong nodes. */
  async function handleRemoveField(target: { kind: string; name: string }, pointer: string) {
    if (!state.workspace || !state.activeModulePath) return;
    const updated = removeResourceFieldItem(
      state.workspace,
      state.activeModulePath,
      target.kind,
      target.name,
      pointer,
    );
    if (updated === state.workspace) return;
    const persisted = await persistModule(updated, state.activeModulePath);
    setState((s) => ({ ...s, workspace: persisted }));
  }

  /** Renames one mapping key inside a resource's fields — its own AST op, since
   *  a field diff would read the change as a delete plus an add. */
  async function handleRenameField(
    target: { kind: string; name: string },
    pointer: string,
    newKey: string,
  ) {
    if (!state.workspace || !state.activeModulePath) return;
    const updated = renameResourceFieldKey(
      state.workspace,
      state.activeModulePath,
      target.kind,
      target.name,
      pointer,
      newKey,
    );
    if (updated === state.workspace) return;
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
        onOpen={openMode === "chooser" ? handleOpen : undefined}
        onOpenSettings={() => setSettingsOpen(true)}
        onUndo={canUndo ? () => void handleUndo() : undefined}
        onRedo={canRedo ? () => void handleRedo() : undefined}
        canUndo={canUndo}
        canRedo={canRedo}
        onToggleChat={agentVisible ? agent.togglePanel : undefined}
        chatOpen={agent.panelOpen}
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
          onNewModule={setCreateModuleKind}
          onDeleteModule={handleDeleteModule}
          onRunModule={handleRunModule}
        />
        {!state.workspace ? (
          <AppLifecyclePanel
            onOpen={handleOpen}
            onStartFromTemplate={() => setCreateModuleKind("Application")}
            openMode={openMode}
            recentRootDir={persistedHint?.rootDir}
          />
        ) : (
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <EditorTabs items={tabItems} onActivate={handleActivateTab} onClose={handleCloseTab} />
            {activeIsRemote && (
              <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1 text-xs text-amber-700 dark:text-amber-300">
                <Lock className="size-3 shrink-0" />
                <span className="font-medium">Remote module · read-only</span>
                <span className="truncate text-amber-600/70 dark:text-amber-400/70">
                  {state.activeModulePath}
                </span>
              </div>
            )}
            <div className="flex min-h-0 flex-1 overflow-hidden">
              {activeTab?.type === "file" ? (
                <FileEditor
                  key={activeTab.path}
                  filePath={activeTab.path}
                  readFile={readFileCb}
                  saveFile={saveFileCb}
                  readOnly={agentLocked}
                />
              ) : activeTab?.type === "module" && viewData ? (
                <ViewContainer
                  activeView={state.activeView}
                  onChangeView={(view) => setState((s) => ({ ...s, activeView: view }))}
                  viewProps={{
                      readOnly: readOnlyReason !== null,
                      readOnlyReason,
                      viewData,
                      registry:
                        (state.activeModulePath
                          ? state.diagnostics.registryByFile.get(state.activeModulePath)
                          : undefined) ?? null,
                      selectedResource: state.selectedResource,
                      selection,
                      onSelectResource: handleSelectResource,
                      onNavigateResource: handleNavigateResource,
                      onOpenModule: handleOpenModule,
                      onUpdateResource: handleUpdateResource,
                      onDeleteResource: handleDeleteResource,
                      onWriteRef: handleWriteRef,
                      onCreateAndLink: handleCreateAndLink,
                      onRenameField: handleRenameField,
                      onMoveField: handleMoveField,
                      onRelocateField: handleRelocateField,
                      onRemoveField: handleRemoveField,
                      onCreateResource: () => setCreateResourceOpen(true),
                      onCreateResourceOfKind: handleCreateResourceOfKind,
                      hubUrl: settings.hubUrl,
                      manifestCacheUrl: settings.manifestCacheUrl,
                      onAddImport: handleAddImport,
                      importableLibraries,
                      onRemoveImport: handleRemoveImport,
                      onUpgradeImport: handleUpgradeImport,
                      onUpgradeAllImports: handleUpgradeAllImports,
                      onSelect: handleSelect,
                      onClearSelection: handleClearSelection,
                      onSourceEdit: handleSourceEdit,
                      onExtractInline: handleExtractInline,
                      onInlineReference: handleInlineReference,
                      deployment: {
                        activeEnvironment: readActiveEnvironment(
                          state.deploymentsByApp,
                          state.activeModulePath,
                        ),
                        onSetEnvVars: handleSetDeploymentEnvVars,
                      },
                      run: {
                        appPath: activeAppPath,
                        onRun: () => {
                          if (activeAppPath) void handleRunModule(activeAppPath);
                        },
                        runnerName: activeRunnerName,
                        onOpenSettings: () => setSettingsOpen(true),
                      },
                      revealRequest: state.sourceRevealRequest,
                      topology: {
                        focusPath: activeTopology.focusPath,
                        onFocusPath: handleFocusPath,
                        focusRequest: activeTopology.focusRequest,
                        viewIdByChoiceKey: settings.topologyViewByChoiceKey ?? {},
                        onPickView: handlePickTopologyView,
                        viewState: activeTopology.viewState,
                        onViewState: handleTopologyViewState,
                        viewportFor: (key) =>
                          state.activeModulePath
                            ? (state.viewportByModule[`${state.activeModulePath}#${key}`] ?? null)
                            : null,
                        onViewportChange: handleCanvasViewportChange,
                      },
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
        {/* The panel owns its own width — the user drags it, and it persists. */}
        {agentVisible && agent.panelOpen && <AgentPanel className="shrink-0" />}
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
      <CreateModuleDialog
        open={createModuleKind !== null}
        onOpenChange={(open) => !open && setCreateModuleKind(null)}
        kind={createModuleKind ?? "Application"}
        templatesBaseUrl={resolveTemplatesBaseUrl(settings)}
        onCreate={createNewModule}
      />
      <TermsGateDialog
        terms={termsGate?.terms ?? null}
        onAccept={() => {
          if (!termsGate) return;
          acceptTermsFor(termsGate.runnerId, termsGate.terms.version);
          // Agent launches send the same acceptance; update it live so the
          // agent doesn't stay 428-gated until the next runner switch.
          if (termsGate.runnerId === settings.activeRunnerId) {
            setAgentRunnerTerms(termsGate.terms.version);
          }
          const { resume } = termsGate;
          setTermsGate(null);
          // Resume whatever the gate interrupted. The accepted version is on the
          // agent's ref by now, so its retry launches with the header set.
          if (resume.kind === "run") void handleRunModuleRef.current(resume.filePath);
          else agentRetry();
        }}
        onDecline={() => setTermsGate(null)}
      />
      <AlertDialog open={pendingImport !== null} onOpenChange={onImportDialogOpenChange}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Open in Telo Studio</AlertDialogTitle>
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
      <ReferencesBlockedDialog
        name={inlineBlocked?.name ?? null}
        move="inline"
        references={inlineBlocked?.references ?? []}
        reason={inlineBlocked?.reason}
        onOpenChange={(open) => !open && setInlineBlocked(null)}
        onSelectResource={handleSelectResource}
      />
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
