import { makeTaggedSentinel } from "@telorun/templating";
import { suggestedResourceName } from "../resource-naming";
import { planInlineExtraction, planReferenceInlining } from "../inline-extraction";
import { concretePathToPointer } from "../lib/concrete-path";
import { readPointer } from "../lib/json-pointer";
import { parseRefValue } from "./resource-schema-form/ref-candidates";
import { ReferencesBlockedDialog } from "./views/topology/ReferencesBlockedDialog";
import { File as FileIcon, Lock } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast as sonnerToast } from "sonner";
import { accountsOriginForThisPage } from "../products/page-products";
import { isModuleRootKind, moduleRootResource } from "../application-adapter";
import { HistoryManager } from "../history/manager";
import { LocalStorageHistoryStore } from "../history/store";
import { useEditorPersistence } from "../hooks/useEditorPersistence";
import { useImportOps, type ModuleImportUpgrades } from "../hooks/useImportOps";
import { useWorkspaceLifecycle } from "../hooks/useWorkspaceLifecycle";
import { INITIAL_STATE, pickInitialActiveModule } from "../editor-state";
import { knownReferences, referenceSlotsToClear, type ResourceReference } from "../resource-references";
import {
  createManifestSources,
  createResourceViaAst,
  deleteModule,
  getImportableLibraries,
  hasUnresolvedImports,
  loadWorkspace,
  noopAdapter,
  normalizePath,
  firstWorkspaceModule,
  hasNoWorkspaceModules,
  isWorkspaceModule,
  moduleOwningFile,
  moduleSubtree,
  persistWorkspaceModule,
  rebuildManifestFromDocuments,
  reconcileImports,
  removeResourceViaAst,
  resolveStartersBaseUrl,
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
import { envFileProblems, resolveApplicationEnv } from "../run/application-env";
import { resolveDeclaredPorts } from "./views/run/declared-ports";
import {
  AGENT_APP_NAME,
  desiredAppSet,
  adoptDeviceSessions,
  desktopResumeSecretStore,
  entryResumeSecretStore,
  forgetIdentitySessions,
  listWorkspaceSessionEntries,
  loadWorkspaceSessionEntry,
  pageDpopKeyStore,
  pageWorkspaceIdentity,
  referenceOutsideWorkspace,
  registry as runRegistry,
  runVersionFor,
  saveWorkspaceSessionEntry,
  useRun,
  type DesiredAppSet,
  type RunAppRequest,
  type RunnerTerms,
  type SessionPort,
  type WorkspaceApplication,
} from "../run";
import { buildProgress, isFocusComposerShortcut, useAgent } from "../agent";
import { isTauri } from "@tauri-apps/api/core";
import { useCloud } from "../cloud/context";
import {
  clearProjectLinkParams,
  decideProjectLink,
  forgetProjectLinkSignIn,
  noteProjectLinkSignIn,
  projectLinkSignInTried,
  readProjectLink,
  type ProjectLink,
} from "../cloud/project-link";
import { cloudProjectIdOf, cloudWorkspaceRoot } from "../cloud/working-copy-adapter";
import { useWorkspaceMode } from "../hooks/useWorkspaceMode";
import { findWorkingCopy } from "../cloud/working-copy-index";
import { CloudProjectBar } from "./cloud/CloudProjectBar";
import type { OpenWorkspaceKind } from "./WorkspaceSwitcher";
import type { WorkspaceBridge } from "../agent";
import { editorWorkspaceBridge } from "./editor-workspace-bridge";
import { AgentPanel } from "./agent/AgentPanel";
import { EmptyWorkspacePanel } from "./EmptyWorkspacePanel";
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
import { RegionErrorBoundary } from "./RegionErrorBoundary";
import { useLanguageSession } from "../hooks/useLanguageSession";
import { useViewModel } from "../hooks/useViewModel";
import { CelFieldContext, type CelFieldSource } from "../language/cel-field-context";
import { LanguageModelsContext } from "../language/language-models-context";
import { moduleGraphFromData } from "../language/module-graph-from-data";
import { structuredModelOf } from "../language/structured-model";
import type { ViewModelStatus } from "../language/view-model-store";
import { getModuleFiles } from "../diagnostics-aggregate";
import { SettingsModal } from "./SettingsModal";
import { Sidebar } from "./sidebar/Sidebar";
import { pinDroppedMessage } from "./sidebar/useImportUpgrade";
import { useModuleVersions } from "./sidebar/useModuleVersions";
import { useVersionCompatibility } from "./sidebar/useVersionCompatibility";
import { useWorkspaceImportUpgrades } from "./sidebar/useWorkspaceImportUpgrades";
import { ImportLookupNotice } from "./sidebar/ImportLookupNotice";
import { TermsGateDialog } from "./TermsGateDialog";
import { WorkspaceModeDialog } from "./WorkspaceModeDialog";
import { TopBar } from "./TopBar";
import { acceptTermsFor, isTermsAcceptedFor } from "../storage";
import { ViewContainer } from "./views/ViewContainer";
import type { ViewProps } from "./views/types";
import type { RefWrite } from "./views/topology/ref-write";
import { templateGraphFromViewModel } from "./views/topology/module-graph-view/template-graph";
import { leafConcreteIndex, writeConcretePath } from "../lib/concrete-path";
import type { Range } from "@telorun/analyzer";

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
    (s.activeView === "run" || s.activeView === "cloud") && nextModule?.kind !== "Application"
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
  const runContextRef = useRef(runContext);
  runContextRef.current = runContext;
  // Whether this environment can offer a CHOICE of workspace. Fixed for the
  // session — it is a property of the host, not of what is open.
  const openMode = workspaceOpenMode();
  const agent = useAgent();
  const agentLocked = agent.locked;
  const agentLockedRef = useRef(agentLocked);
  agentLockedRef.current = agentLocked;
  const cloud = useCloud();
  // Why nothing may be written right now, or null. One reason for every write
  // path — forms, source, files, undo — so no path can forget one of them.
  const cloudLock = cloud.editingLock;
  const editingPaused: string | null = agentLocked
    ? "Editing is paused while the agent is working."
    : cloudLock === "viewer"
      ? "You have read-only access to this Telo Cloud project."
      : cloudLock === "updating"
        ? "Editing is paused while the workspace is updated."
        : null;
  const editingPausedRef = useRef(editingPaused);
  editingPausedRef.current = editingPaused;
  const [error, setError] = useState<string | null>(null);
  // The console's link to a Telo Cloud project, until it is settled. The
  // desktop build reads no query parameters.
  const [projectLink, setProjectLink] = useState<ProjectLink | null>(() =>
    isTauri() ? null : readProjectLink(window.location.search),
  );
  // A link decides what opens, so the last workspace is not restored under it
  // — nor after it was refused, where the message stands alone.
  const [restoreDeferred, setRestoreDeferred] = useState(projectLink !== null);
  const [linkedModule, setLinkedModule] = useState<{
    rootDir: string;
    modulePath: string;
    projectName: string;
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The sidebar as a drawer; read at phone width only.
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  // The pending terms gate: the runner's terms, the runner they belong to, and
  // what to resume once accepted — the run that was blocked, or the session
  // waiting to be created. Null when no gate is shown.
  const [termsGate, setTermsGate] = useState<{
    terms: RunnerTerms;
    runnerId: string;
    resume: { kind: "run"; filePath: string } | { kind: "session" };
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
    workspaceChanges,
    handleOpen,
    createNewModule,
    handleConfirmImport,
    onImportDialogOpenChange,
    refreshFileTree,
    afterFileMutation,
    openRoot,
    closeRoot,
    openBrowserWorkspace,
    closeWorkspace,
    browserWorkspaceOpen,
    reloadFromDisk,
  } = useWorkspaceLifecycle({
    state,
    setState,
    settings,
    persistedHint,
    setError,
    restoreDeferred,
  });

  // Bridge the editor's workspace to the authoring agent: content-hash the tree
  // for two-way sync, and reflect the agent's writes back through the same
  // WorkspaceAdapter + afterFileMutation the manual editors use. One conversation
  // per workspace, keyed by rootDir.
  const agentRootDir = state.workspace?.rootDir ?? null;
  const {
    registerWorkspace: registerAgentWorkspace,
    setConversation: setAgentConversation,
    setSessionAgent,
  } = agent;
  // The agent keeps the registered bridge as state, so its identity must follow
  // the workspace root alone: `afterFileMutation` is a new function every
  // render and is read through a ref, as the adapter is.
  const afterFileMutationRef = useRef(afterFileMutation);
  afterFileMutationRef.current = afterFileMutation;
  const workspaceBridge = useMemo<WorkspaceBridge | null>(() => {
    if (!agentRootDir) return null;
    return editorWorkspaceBridge({
      rootDir: agentRootDir,
      adapter: () => workspaceAdapterRef.current,
      afterFileMutation: (affected) => afterFileMutationRef.current(affected),
    });
  }, [agentRootDir, workspaceAdapterRef]);

  useEffect(() => {
    registerAgentWorkspace(workspaceBridge);
    return () => registerAgentWorkspace(null);
  }, [registerAgentWorkspace, workspaceBridge]);

  useEffect(() => {
    setAgentConversation(agentRootDir);
  }, [setAgentConversation, agentRootDir]);

  // ---------------------------------------------------------------------------
  // The workspace's mode and its runner session
  // ---------------------------------------------------------------------------

  // How the open workspace is used, chosen the first time it opens and
  // remembered per workspace; null while the choice is still to be made.
  const { workspaceMode, chooseWorkspaceMode, openingModeRef, resumeOnLoad, chooseResumeOnLoad } =
    useWorkspaceMode(agentRootDir);

  // The resume secret's home: the web build keeps it in the workspace's entry;
  // the desktop build in the OS credential store, through the shell.
  const resumeSecrets = useMemo(() => (isTauri() ? desktopResumeSecretStore() : entryResumeSecretStore()), []);

  const activeRunner = settings.runners.find((r) => r.id === settings.activeRunnerId) ?? null;
  const activeRunnerAdapter = activeRunner ? runRegistry.get(activeRunner.adapterId) : undefined;
  const { bindWorkspace } = runContext;

  // The signed-in identity as runner sessions use it — one per sign-in, so a
  // session is rebound exactly when who is signed in changes. Nothing is bound
  // until Studio knows whether anyone is signed in and who its identity
  // provider is: a session created with a resume secret a moment before the
  // answer would only be adopted at once.
  const signedInUser = cloud.session.status === "signedIn" ? cloud.session.identity.user.id : null;
  const [issuer, setIssuer] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void accountsOriginForThisPage().then((origin) => {
      if (live) setIssuer(origin);
    });
    return () => {
      live = false;
    };
  }, []);
  const identityKnown = cloud.session.status !== "loading" && issuer !== null;
  const workspaceIdentity = useMemo(
    () => (signedInUser !== null && issuer !== null ? pageWorkspaceIdentity(issuer, signedInUser) : null),
    [signedInUser, issuer],
  );
  // A DPoP key belongs to the sign-in its runner grants were issued to: signed
  // out, every key goes; signed in, every other subject's.
  const keySubject =
    cloud.session.status === "signedIn" ? signedInUser : cloud.session.status === "anonymous" ? null : undefined;
  useEffect(() => {
    if (keySubject === undefined) return;
    pageDpopKeyStore()
      .forgetAllBut(keySubject)
      .catch((err: unknown) => {
        sonnerToast.error("A runner sign-in key of an earlier sign-in could not be deleted", {
          description: err instanceof Error ? err.message : String(err),
          duration: 10_000,
        });
      });
  }, [keySubject]);
  // Signing out (or in as someone else) leaves the identity's sessions with
  // it on their runners, and this device forgets them. Before the binding
  // below, so a rebind never reads an id the identity owns.
  const previousUserRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousUserRef.current;
    previousUserRef.current = signedInUser;
    if (previous !== null && previous !== signedInUser) forgetIdentitySessions();
  }, [signedInUser]);
  // Signing in adopts every other workspace's resume-secret session on a
  // runner that accepts the identity; the open one is adopted as it rebinds.
  const adoptionScopeRef = useRef({ openWorkspace: agentRootDir, runners: settings.runners });
  adoptionScopeRef.current = { openWorkspace: agentRootDir, runners: settings.runners };
  useEffect(() => {
    if (!workspaceIdentity) return;
    const { openWorkspace, runners } = adoptionScopeRef.current;
    const targets = listWorkspaceSessionEntries().flatMap(({ workspaceKey, entry }) => {
      if (workspaceKey === openWorkspace) return [];
      const runner = runners.find((r) => r.id === entry.runner);
      const adapter = runner ? runRegistry.get(runner.adapterId) : undefined;
      if (!runner || !adapter) return [];
      return [{ workspaceKey, entry, runner: { id: runner.id, adapter, config: runner.config ?? adapter.defaultConfig } }];
    });
    if (targets.length === 0) return;
    void adoptDeviceSessions({
      targets,
      secrets: resumeSecrets,
      identity: workspaceIdentity,
      saveEntry: saveWorkspaceSessionEntry,
    }).then((outcomes) => {
      for (const outcome of outcomes) {
        if (outcome.kind !== "failed") continue;
        sonnerToast.error("A workspace's session could not be moved to your sign-in", {
          description: `${outcome.workspaceKey}: ${outcome.error.message}`,
          duration: 10_000,
        });
      }
    });
  }, [workspaceIdentity, resumeSecrets]);
  // Agent or Manual binds the workspace to its session on the active runner;
  // Only on this device, an undecided mode, or no runner binds nothing — and
  // so contacts no runner at all.
  const sessionMode = workspaceMode === "agent" || workspaceMode === "manual" ? workspaceMode : null;
  const prepareRunRef = useRef<(appPath: string) => Promise<RunAppRequest | null>>(async () => null);
  useEffect(() => {
    if (!agentRootDir || !sessionMode || !activeRunner || !activeRunnerAdapter || !workspaceBridge || !identityKnown) {
      bindWorkspace(null);
      return;
    }
    const entry = loadWorkspaceSessionEntry(agentRootDir);
    if (!entry) return;
    bindWorkspace({
      workspaceKey: agentRootDir,
      entry,
      mode: sessionMode,
      runner: {
        id: activeRunner.id,
        name: activeRunner.name,
        adapter: activeRunnerAdapter,
        config: activeRunner.config ?? activeRunnerAdapter.defaultConfig,
      },
      termsAccepted: (terms) => isTermsAcceptedFor(activeRunner.id, terms.version),
      secrets: resumeSecrets,
      identity: workspaceIdentity,
      saveEntry: (next) => saveWorkspaceSessionEntry(agentRootDir, next),
      bridge: workspaceBridge,
      prepareRun: (appPath) => prepareRunRef.current(appPath),
    });
  }, [
    agentRootDir,
    sessionMode,
    activeRunner,
    activeRunnerAdapter,
    workspaceBridge,
    bindWorkspace,
    resumeSecrets,
    identityKnown,
    workspaceIdentity,
  ]);

  // The ports each Application declares, resolved against its env files —
  // read again when a manifest or an env file changes.
  const [appPorts, setAppPorts] = useState<Map<string, SessionPort[]> | null>(null);
  const [envEpoch, setEnvEpoch] = useState(0);
  useEffect(
    () =>
      workspaceChanges.subscribe((change) => {
        const envPath = (path: string) => /(^|[\\/])(\.env[^\\/]*|telo-workspace\.yaml)$/.test(path);
        if (change.kind === "workspace" || change.paths.some(envPath)) setEnvEpoch((e) => e + 1);
      }),
    [workspaceChanges],
  );
  const sessionWorkspaceModules = sessionMode ? (state.workspace ?? null) : null;
  useEffect(() => {
    const workspace = sessionWorkspaceModules;
    const adapter = workspaceAdapterRef.current;
    if (!workspace || !adapter) {
      setAppPorts(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const ports = new Map<string, SessionPort[]>();
      for (const manifest of workspace.modules.values()) {
        if (manifest.kind !== "Application") continue;
        let env: Record<string, string> = {};
        try {
          env = (await resolveApplicationEnv(adapter, workspace.rootDir, manifest.filePath)).values;
        } catch (err) {
          // The set takes the declared defaults; Run reads the files again and
          // shows this failure as the app's blocker.
          console.warn(`Couldn't read the env files of ${manifest.filePath}:`, err);
        }
        ports.set(manifest.filePath, resolveDeclaredPorts(manifest, env));
      }
      if (!cancelled) setAppPorts(ports);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionWorkspaceModules, workspaceAdapterRef, envEpoch]);

  // Every write to the workspace — a save, a form edit, a file operation, the
  // agent's own sync — reaches its session, which a running app reads.
  const { syncWorkspace: syncSession } = runContext;
  useEffect(() => workspaceChanges.subscribe(() => syncSession()), [workspaceChanges, syncSession]);

  // The session's agent is the panel's.
  const { sessionAgent } = runContext;
  useEffect(() => {
    setSessionAgent(sessionAgent);
  }, [sessionAgent, setSessionAgent]);

  // An app-set change waits for an agent turn to end.
  const { setTurnActive } = runContext;
  useEffect(() => {
    setTurnActive(agentLocked);
  }, [agentLocked, setTurnActive]);

  // The runner's terms gate a session's create: shown here, accepted per
  // runner and version.
  const sessionTerms = runContext.session?.phase === "terms" ? runContext.session.terms : null;
  useEffect(() => {
    if (!sessionTerms || !activeRunner) return;
    setTermsGate({ terms: sessionTerms, runnerId: activeRunner.id, resume: { kind: "session" } });
  }, [sessionTerms, activeRunner]);

  // With no workspace open, the closed-workspace screen takes a request when
  // the active runner offers the agent: asked of the runner only then.
  const [closedScreenAgent, setClosedScreenAgent] = useState(false);
  useEffect(() => {
    setClosedScreenAgent(false);
    if (agentRootDir || !activeRunner || !activeRunnerAdapter?.fetchCapabilities) return;
    let cancelled = false;
    activeRunnerAdapter
      .fetchCapabilities(activeRunner.config as never)
      .then((caps) => {
        if (!cancelled) setClosedScreenAgent(caps?.features?.agents?.includes(AGENT_APP_NAME) === true);
      })
      .catch((err: unknown) => {
        // Unreachable or malformed: no request is offered, and the run UI
        // reports the runner's fault when a workspace opens.
        if (!cancelled) {
          setClosedScreenAgent(false);
          console.warn("Couldn't read the runner's capabilities:", err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agentRootDir, activeRunner, activeRunnerAdapter]);

  // Agent mode offers the agent — unless the runner turns out to offer none and
  // no agent URL is set; Manual and Only on this device hide it, as does a
  // viewer of a Telo Cloud project, who cannot change it. The user-set agent
  // URL applies in Agent mode, and keeps the closed-workspace screen's request
  // offered.
  const overridden = agent.overrideUrl.trim() !== "";
  const agentVisible =
    cloudLock !== "viewer" &&
    (agentRootDir
      ? workspaceMode === "agent" && (overridden || runContext.session?.agentOffered !== false)
      : closedScreenAgent || overridden);
  // Every way into the composer is offered exactly where the panel's toggle is.
  const { setPanelAvailable: setAgentPanelAvailable, focusComposer: focusAgentComposer } = agent;
  useEffect(() => {
    setAgentPanelAvailable(agentVisible);
    return () => setAgentPanelAvailable(false);
  }, [agentVisible, setAgentPanelAvailable]);
  useEffect(() => {
    if (!agentVisible) return;
    // Captured: the source view's editor would otherwise see the key first.
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isFocusComposerShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      focusAgentComposer();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [agentVisible, focusAgentComposer]);

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

  // Where the Variables tab reads and writes: the open workspace's env files.
  const workspaceRoot = state.workspace?.rootDir ?? null;
  const viewEnvironment = useMemo<ViewProps["environment"] | null>(
    () =>
      workspaceRoot === null
        ? null
        : {
            rootDir: workspaceRoot,
            adapter: () => workspaceAdapterRef.current,
            changes: workspaceChanges,
          },
    [workspaceRoot, workspaceAdapterRef, workspaceChanges],
  );

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
    let updated: Workspace;
    try {
      updated = await deleteModule(workspace, filePath, adapter);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    // The run context is keyed by module path, so a deleted module's runs,
    // dock, blocker and selection would outlive it — a session still running
    // for an application that is gone, and all of it inherited by a module
    // later created at the same path. Every module nested in it goes too.
    for (const path of moduleSubtree(workspace, filePath)) runContext.forgetApp(path);
    const dir = pathDirname(filePath);
    const gone = (path: string) => path.startsWith(dir + "/");
    setState((s) => {
      const openTabs = s.openTabs.filter((t) => !gone(t.path));
      const wasActiveTab = s.activeTabId !== null && gone(s.activeTabId);
      const nextActive =
        s.activeModulePath !== null && gone(s.activeModulePath)
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
   * The Run request for an Application, read fresh: its env files are the
   * run's whole environment, and every refusal a run can be told before it
   * starts is shown as its dock's blocker (null then). Used by Run and by the
   * session starting an app again after its pod was recreated.
   */
  async function prepareRun(filePath: string): Promise<RunAppRequest | null> {
    const workspace = state.workspace;
    const workspaceAdapter = workspaceAdapterRef.current;
    if (!workspace || !workspaceAdapter) return null;
    const runnerLabel = activeRunner?.name ?? "Runner";

    // A session holds the opened folder's tree and nothing above it.
    const outside = referenceOutsideWorkspace(workspace, filePath);
    if (outside) {
      const relative = (path: string) => path.replace(/\\/g, "/").replace(`${workspace.rootDir.replace(/\\/g, "/").replace(/\/+$/, "")}/`, "");
      runContext.showBlocker(filePath, {
        kind: "outside-workspace",
        importer: relative(outside.importer),
        source: outside.source,
        target: outside.target,
      });
      return null;
    }

    // The version this module is edited against is the version it runs on; a
    // module with no engine has no version, and the status that explains why
    // is the reason shown.
    const versioned = runContext.session?.capabilities?.features.teloVersions === true;
    const version = versioned ? runVersionFor(teloLanguage, filePath) : null;
    if (version && "refusal" in version) {
      runContext.showBlocker(filePath, {
        kind: "unavailable",
        adapterId: activeRunner?.adapterId ?? "",
        adapterDisplayName: runnerLabel,
        message: version.refusal,
        remediation: "Resolve the telo version shown in the top bar, then run again.",
      });
      return null;
    }

    // The workspace's env files are the run's whole environment, read fresh
    // now: Studio has no shell to fall back on, so a file it cannot read — or a
    // marker that bounds them wrongly — refuses the run rather than leaving a
    // value out.
    let environment;
    try {
      environment = await resolveApplicationEnv(workspaceAdapter, workspace.rootDir, filePath);
    } catch (err) {
      setError(`Failed to read the env files: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    const envProblems = envFileProblems(environment, workspace.rootDir);
    if (envProblems.length > 0) {
      runContext.showBlocker(filePath, { kind: "env-files", problems: envProblems });
      return null;
    }
    const env = { ...environment.values };

    // Pre-flight required variables/secrets so a missing value sends the user to
    // the Variables tab instead of failing at boot with a validation error.
    const manifest = workspace.modules.get(filePath) ?? null;
    const missing = findMissingRequiredEnv(manifest, env);
    if (missing.length > 0) {
      runContext.showBlocker(filePath, {
        kind: "missing-config",
        entries: missing.map((entry) => ({ name: entry.name, envVar: entry.envVar, secret: entry.secret })),
      });
      return null;
    }
    return { env, io: runContext.runIo() };
  }
  prepareRunRef.current = prepareRun;

  /**
   * Run an Application in the workspace's session: a process start in the
   * app's existing container. An app the session does not hold yet (its set
   * waits for an agent turn to end) waits and runs once it is applied.
   */
  async function handleRunModule(filePath: string) {
    setError(null);
    // The dock states why the LAST press failed, so it is cleared with the same
    // gesture that clears the error banner.
    runContext.clearBlocker(filePath);
    // A run lives in its own Application's pane, so running one from the
    // sidebar brings it forward.
    if (state.activeModulePath !== filePath) handleOpenModule(filePath);
    if (!state.workspace) return;
    if (!sessionMode) return;

    const runner = activeRunner;
    if (!runner) {
      setError("No runner selected. Add or select a runner in Settings.");
      setSettingsOpen(true);
      return;
    }
    const adapter = activeRunnerAdapter;
    if (!adapter) {
      setError(`Runner "${runner.name}" uses an unavailable adapter "${runner.adapterId}".`);
      setSettingsOpen(true);
      return;
    }
    const config = runner.config ?? adapter.defaultConfig;
    if (adapter.validateConfig(config).length > 0) {
      setSettingsOpen(true);
      return;
    }

    const session = runContext.session;
    if (session?.phase === "failed") {
      runContext.showBlocker(filePath, {
        kind: "unavailable",
        adapterId: adapter.id,
        adapterDisplayName: runner.name,
        message: session.problem ?? "The workspace's session could not be opened.",
        recheck: async () => {
          runContext.clearBlocker(filePath);
          runContext.retrySession();
        },
      });
      return;
    }
    if (session?.phase === "terms" && session.terms) {
      setTermsGate({ terms: session.terms, runnerId: runner.id, resume: { kind: "session" } });
      return;
    }

    let availability;
    try {
      availability = await adapter.isAvailable(config);
    } catch (err) {
      setError(`Failed to probe ${adapter.displayName}: ${err instanceof Error ? err.message : String(err)}`);
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
            runContext.retrySession();
            void handleRunModuleRef.current(filePath);
          }
        },
      });
      return;
    }

    if (runContext.appNameOf(filePath) === null) {
      runContext.showBlocker(filePath, {
        kind: "unavailable",
        adapterId: adapter.id,
        adapterDisplayName: runner.name,
        message: "This application is not part of the workspace's session yet.",
        remediation: "Its telo version is still being resolved — run again in a moment.",
      });
      return;
    }

    const liveRun = runContext.liveRunForApp(filePath);
    if (liveRun) {
      const proceed = window.confirm("Stop the current run and start a new one?");
      if (!proceed) return;
      await runContext.stopRun(liveRun.id);
    }

    const request = await prepareRun(filePath);
    if (!request) return;
    try {
      await runContext.runApp(filePath, request);
    } catch (err) {
      setError(`Failed to start run: ${err instanceof Error ? err.message : String(err)}`);
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
    // Single chokepoint for every manifest write (form edits, source edits,
    // undo/redo, import ops): while an agent turn holds the workspace, nothing
    // may land — a mid-turn write isn't in the agent's seeded tree and the
    // end-of-turn reconcile would silently revert it.
    if (editingPausedRef.current) {
      setError(editingPausedRef.current);
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

    return next;
  }

  // Import authoring for the active module — add / remove / upgrade.
  const {
    handleAddImport,
    handleRemoveImport,
    handleUpgradeImport,
    handleUpgradeAllImports,
    upgradeModuleImports,
  } = useImportOps({ state, setState, settings, manifestAdapterRef, persistModule });

  // The workspace-wide upgrade: every module's imports, one click from the top
  // bar or a section header. The same hub lookups the module bar makes, so an
  // upgrade offered here lands on the same version it would there.
  const listVersions = useModuleVersions(settings.hubUrl);
  const isCompatible = useVersionCompatibility(settings.manifestCacheUrl);
  const { outdated: workspaceUpgrades, failures: importLookupFailures } =
    useWorkspaceImportUpgrades(state.workspace, listVersions, isCompatible);
  const [upgradingImports, setUpgradingImports] = useState(false);

  async function handleUpgradeWorkspaceImports(filePaths: string[]) {
    const plan: ModuleImportUpgrades[] = filePaths.flatMap((filePath) => {
      const upgrades = workspaceUpgrades.get(filePath);
      return upgrades?.length ? [{ filePath, upgrades }] : [];
    });
    if (plan.length === 0) return;
    setUpgradingImports(true);
    try {
      await upgradeModuleImports(plan);
      const unpinned = plan
        .flatMap((entry) => workspaceUpgrades.get(entry.filePath) ?? [])
        .filter((u) => u.wasPinned && !u.repinned).length;
      if (unpinned > 0) setError(pinDroppedMessage(unpinned));
    } catch (err) {
      setError(`Failed to upgrade imports: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUpgradingImports(false);
    }
  }

  // What the editor lends the Telo Cloud layer: it owns the open workspace, so
  // opening one, closing it and re-reading it after an update rewrote the
  // working copy are done here. Read through a ref — these close over state.
  const cloudHostRef = useRef({ openRoot, closeRoot, reloadFromDisk });
  cloudHostRef.current = { openRoot, closeRoot, reloadFromDisk };
  const { registerHost: registerCloudHost, setActiveRoot: setCloudActiveRoot } = cloud;
  useEffect(() => {
    registerCloudHost({
      open: (rootDir) => cloudHostRef.current.openRoot(rootDir),
      close: (rootDir) => cloudHostRef.current.closeRoot(rootDir),
      reload: async () => {
        await cloudHostRef.current.reloadFromDisk();
        // A running app reads the session's copy of these files, not this one.
        runContextRef.current.syncWorkspace();
      },
      idle: () => !agentLockedRef.current && !runContextRef.current.syncing(),
    });
    return () => registerCloudHost(null);
  }, [registerCloudHost]);

  const workspaceRootDir = state.workspace?.rootDir ?? null;
  useEffect(() => {
    setCloudActiveRoot(workspaceRootDir);
  }, [setCloudActiveRoot, workspaceRootDir]);

  // A project link: sign in to its organization when needed, open the project's
  // working copy, and say why when it cannot be opened.
  const projectLinkStartedRef = useRef(false);
  useEffect(() => {
    if (!projectLink) {
      forgetProjectLinkSignIn();
      return;
    }
    if (projectLinkStartedRef.current) return;
    const decision = decideProjectLink(
      projectLink,
      cloud.session,
      projectLinkSignInTried(projectLink),
    );
    if (decision.action === "wait") return;
    if (decision.action === "ignore") {
      setProjectLink(null);
      setRestoreDeferred(false);
      return;
    }
    projectLinkStartedRef.current = true;
    if (decision.action === "signIn") {
      noteProjectLinkSignIn(projectLink);
      cloud.signInToOrganization(projectLink.orgId);
      return;
    }
    clearProjectLinkParams();
    if (decision.action === "refuse") {
      setError(decision.message);
      setProjectLink(null);
      return;
    }
    void (async () => {
      try {
        const projects = await cloud.api.listProjects();
        const project = projects.find((candidate) => candidate.id === projectLink.projectId);
        if (!project) {
          setError(
            `The linked project ${projectLink.projectId} could not be opened: it does not exist, or you have no access to it.`,
          );
          return;
        }
        const result = await cloud.openProject(project);
        if (!result.ok) {
          setError(result.message);
          return;
        }
        if (projectLink.modulePath) {
          setLinkedModule({
            rootDir: cloudWorkspaceRoot(project.id),
            modulePath: projectLink.modulePath,
            projectName: project.name,
          });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setProjectLink(null);
      }
    })();
    // Decided once per session reading; the cloud actions are read as they are.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectLink, cloud.session]);

  // The module a project link names, once that project's workspace is open.
  useEffect(() => {
    const workspace = state.workspace;
    if (!linkedModule || workspace?.rootDir !== linkedModule.rootDir) return;
    const filePath = pathJoin(linkedModule.rootDir, linkedModule.modulePath, "telo.yaml");
    setLinkedModule(null);
    if (workspace.modules.has(filePath)) {
      setState((s) => activateModuleState(s, filePath));
    } else {
      setError(`${linkedModule.projectName} has no module at ${linkedModule.modulePath}.`);
    }
  }, [linkedModule, state.workspace, setState]);

  // The first module written into an empty workspace — usually by the agent —
  // opens when nothing else is.
  const emptyWorkspaceRef = useRef<{ root: string; empty: boolean } | null>(null);
  useEffect(() => {
    const workspace = state.workspace;
    if (!workspace) {
      emptyWorkspaceRef.current = null;
      return;
    }
    const empty = hasNoWorkspaceModules(workspace);
    const previous = emptyWorkspaceRef.current;
    emptyWorkspaceRef.current = { root: workspace.rootDir, empty };
    if (empty || previous?.root !== workspace.rootDir || !previous.empty) return;
    const first = firstWorkspaceModule(workspace);
    if (first) setState((s) => (s.activeTabId === null ? activateModuleState(s, first) : s));
  }, [state.workspace, setState]);

  const agentBuild = useMemo(
    () => buildProgress(agent.messages, agent.status, agent.error),
    [agent.messages, agent.status, agent.error],
  );

  // A workspace opened with nothing in it shows the drawer: at phone width the
  // sidebar is the only way forward there.
  const nothingOpen = state.activeTabId === null;
  useEffect(() => {
    setNavDrawerOpen(workspaceRootDir !== null && nothingOpen);
    // Decided when a workspace opens, not each time its last tab closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceRootDir]);

  const openWorkspaceKind = useMemo((): OpenWorkspaceKind | null => {
    if (!workspaceRootDir) return null;
    const cloudProjectId = cloudProjectIdOf(workspaceRootDir);
    if (cloudProjectId) {
      return {
        kind: "cloud",
        projectId: cloudProjectId,
        name: findWorkingCopy(cloudProjectId)?.projectName ?? "Telo Cloud",
      };
    }
    return browserWorkspaceOpen
      ? { kind: "browser" }
      : { kind: "folder", rootDir: workspaceRootDir };
  }, [workspaceRootDir, browserWorkspaceOpen]);

  function switchWorkspace(opening: Promise<void>): Promise<void> {
    return opening.catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }

  // A request typed with no workspace open: the browser workspace is opened
  // and the request is its conversation's next message.
  // The workspace opens in Agent mode, without asking: the request is for the agent.
  async function buildInBrowserWorkspace(request: string): Promise<boolean> {
    openingModeRef.current = "agent";
    try {
      await openBrowserWorkspace();
    } catch (err) {
      openingModeRef.current = null;
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
    agent.sendOnOpen(request);
    return true;
  }

  async function buildInOpenWorkspace(request: string): Promise<boolean> {
    agent.sendOnOpen(request);
    return true;
  }

  // The active module as Cloud names it: the directory of its `telo.yaml`
  // relative to the repository root.
  const cloudActiveModule = useMemo(() => {
    if (!cloud.active || !activeManifest || !workspaceRootDir) return null;
    const prefix = `${workspaceRootDir}/`;
    if (!activeManifest.filePath.startsWith(prefix)) return null;
    const relative = activeManifest.filePath.slice(prefix.length);
    const slash = relative.lastIndexOf("/");
    return {
      name: activeManifest.metadata.name,
      kind: activeManifest.kind,
      filePath: activeManifest.filePath,
      modulePath: slash === -1 ? "" : relative.slice(0, slash),
    };
  }, [cloud.active, activeManifest, workspaceRootDir]);

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
    if (editingPausedRef.current) {
      return Promise.reject(new Error(editingPausedRef.current));
    }
    return workspaceAdapterRef.current!.writeFile(p, text);
  }, []);

  async function handleCreateFile(parentDir: string, name: string) {
    if (editingPaused) return;
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
    if (editingPaused) return;
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
    if (editingPaused) return;
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
    if (editingPaused) return;
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
    if (editingPaused) return;
    const adapter = workspaceAdapterRef.current;
    if (!adapter) return;
    // A module's manifest stands for the module: deleting it deletes the
    // module's directory and every module nested in it, not the file alone.
    const workspace = state.workspace;
    const manifest = workspace?.modules.get(normalizePath(path));
    if (workspace && manifest && isWorkspaceModule(workspace, manifest.filePath)) {
      const nested = moduleSubtree(workspace, manifest.filePath).length - 1;
      const withNested = nested > 0 ? ` and the ${nested} module${nested === 1 ? "" : "s"} nested in it` : "";
      if (!window.confirm(`Delete ${manifest.metadata.name}? Its directory${withNested} will be removed. This cannot be undone.`)) return;
      await handleDeleteModule(manifest.filePath);
      return;
    }
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

  // Every diagnostic, and the source view's language features, come from the
  // engine of the telo version each module is edited against.
  const {
    language: teloLanguage,
    models: languageModels,
    viewModels,
    session: languageSession,
  } = useLanguageSession({
    state,
    setState,
    settings,
    workspaceAdapterRef,
    navigate: navigateToDiagnostic,
    onShowMessage: (message) => setToast({ title: "Telo", description: message }),
  });

  // The workspace's app set: every Application with its ports and the telo
  // version it is edited against, sent to the session when it changes.
  const versionedRunner = runContext.session?.capabilities?.features.teloVersions === true;
  // Computed each render — the language status it reads has no identity of its
  // own — and sent only when its content changes.
  let desiredApps: DesiredAppSet | null = null;
  if (sessionWorkspaceModules && appPorts) {
    const applications: WorkspaceApplication[] = [];
    for (const manifest of sessionWorkspaceModules.modules.values()) {
      if (manifest.kind !== "Application") continue;
      const version = runVersionFor(teloLanguage, manifest.filePath);
      applications.push({
        filePath: manifest.filePath,
        name: manifest.metadata.name,
        ports: appPorts.get(manifest.filePath) ?? [],
        telo: "version" in version ? version : version.pending ? { pending: true } : { refusal: version.refusal },
      });
    }
    desiredApps = desiredAppSet(sessionWorkspaceModules.rootDir, applications, versionedRunner);
  }
  const desiredKey = desiredApps ? JSON.stringify(desiredApps) : null;
  const desiredRef = useRef(desiredApps);
  desiredRef.current = desiredApps;
  const { setDesiredApps } = runContext;
  useEffect(() => {
    if (desiredRef.current) setDesiredApps(desiredRef.current);
  }, [desiredKey, setDesiredApps]);


  // What the active module's structured views read: the view model its engine
  // serves. A workspace whose language tooling failed to start has none, and
  // says why.
  const activeViewModel = useViewModel(viewModels, state.activeModulePath);
  const viewModelStatus: ViewModelStatus =
    teloLanguage?.kind === "failed"
      ? { state: "failed", error: teloLanguage.failure }
      : (activeViewModel ?? { state: "loading" });
  const activeModel = viewModelStatus.state === "ready" ? viewModelStatus.model : null;
  const activeModuleGraph = activeModel?.moduleGraph ? moduleGraphFromData(activeModel.moduleGraph) : null;
  const celFieldSource = useMemo<CelFieldSource | null>(
    () =>
      languageSession && state.activeModulePath
        ? { session: languageSession, modulePath: state.activeModulePath }
        : null,
    [languageSession, state.activeModulePath],
  );

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
  const structuredModel = activeModel && viewData ? structuredModelOf(activeModel, viewData.kinds) : null;

  // A module's file, by the `metadata.name` a reference crosses the boundary
  // with. Built from the workspace rather than from the graph, because the
  // graph names a module and only the workspace knows where it lives.
  const fileByModuleName = useMemo(() => {
    const out = new Map<string, string>();
    for (const [filePath, manifest] of state.workspace?.modules ?? []) {
      const name = manifest.metadata?.name;
      if (typeof name === "string" && !out.has(name)) out.set(name, filePath);
    }
    return out;
  }, [state.workspace]);

  /** A templated kind's body in the active module's closure, drawn as a module
   *  graph — as the module's engine drew it, so the body resolves every kind
   *  exactly as the module around it does. */
  const templateGraphByKind = useCallback(
    (kindId: string) => (activeModel ? templateGraphFromViewModel(activeModel, kindId) : null),
    [activeModel],
  );

  /** Whether that module's files are editable here — false for one resolved
   *  from a registry / OCI source, whose bytes are not the workspace's. */
  const isEditableModuleName = useCallback(
    (moduleName: string) => {
      const file = fileByModuleName.get(moduleName);
      return !!file && !!state.workspace && isWorkspaceModule(state.workspace, file);
    },
    [fileByModuleName, state.workspace],
  );

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
  const readOnlyReason: "agent" | "remote" | "viewer" | "cloud" | null = agentLocked
    ? "agent"
    : activeIsRemote
      ? "remote"
      : cloudLock === "viewer"
        ? "viewer"
        : cloudLock === "updating"
          ? "cloud"
          : null;

  // Hidden wherever nothing may be written: an upgrade is a write, and the
  // write paths already refuse it while editing is paused.
  const importUpgradeCount = [...workspaceUpgrades.values()].reduce(
    (count, upgrades) => count + upgrades.length,
    0,
  );
  const importUpgradesOffered = readOnlyReason === null;

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

  // Clears every ref slot pointing at `deleted` across the module — the
  // reference sites the module's engine found, every ref shape and nesting —
  // routed through the generic ref writer. The Application root's `targets` are
  // sites like any other, so they are pruned the same way. A site is cleared
  // only where the module as it is now still holds the reference there (the
  // engine's sites may predate an edit); with no view model ready the sites are
  // unknown, so nothing is pruned. Either way the delete lands and the engine
  // reports each reference left dangling.
  function pruneDanglingRefs(ws: Workspace, modulePath: string, deleted: string): Workspace {
    const status = viewModels?.get(modulePath);
    const manifest = ws.modules.get(modulePath);
    if (status?.state !== "ready" || !manifest) return ws;

    // Ref slots only: a CEL read is an expression, and there is no value to
    // write null into. Deleting from the canvas therefore still leaves a CEL
    // read dangling — which the root level's delete refuses over, and which the
    // analyzer reports either way.
    const writes: RefWrite[] = referenceSlotsToClear(status.model, manifest, deleted).map((ref) => ({
      source: ref.source,
      concretePath: ref.path,
      target: null,
    }));
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
      const name = w.createName ?? uniqueResourceName(ws.modules.get(modulePath), w.createKind);
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

    // No view model — or one computed before the latest edit — means the
    // reference set is UNKNOWN, not empty: the one input on which reading it
    // as empty would delete a resource unchecked. A stale model is read again
    // now, so retrying once the engine has caught up finds the current one.
    const status = viewModels?.get(modulePath);
    const known = knownReferences(status, (model) => viewModels!.isCurrent(model), manifest, name);
    if (!known.known) {
      if (status?.state === "ready") viewModels?.refresh(modulePath);
      setInlineBlocked({ name, references: [], reason: known.reason });
      return;
    }
    const refusal = inlineRefusal(manifest, name);
    if (refusal) {
      setInlineBlocked({ name, references: [], reason: refusal });
      return;
    }
    const elsewhere = known.references.filter(
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

  /** Commits a source-view edit for one file, rebuilding and saving the module that owns it. Replaces
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
    // The edited file's own module, not the one on screen: an edit to a nested
    // module's manifest must update that module.
    const owner = state.workspace ? moduleOwningFile(state.workspace, filePath) : undefined;
    if (!state.workspace || !owner) return;

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
    const prevInclude = state.workspace.modules.get(owner)?.include ?? [];
    workspace = rebuildManifestFromDocuments(workspace, owner);
    const nextInclude = workspace.modules.get(owner)?.include ?? [];

    const adapter = manifestAdapterRef.current ?? noopAdapter;
    if (hasUnresolvedImports(workspace, owner)) {
      workspace = await reconcileImports(
        workspace,
        owner,
        adapter,
        createManifestSources(settings),
      );
    }

    workspace = await persistModule(workspace, owner, {
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
            createManifestSources(settings),
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
    <LanguageModelsContext.Provider value={languageModels}>
    <CelFieldContext.Provider value={celFieldSource}>
    <DiagnosticsProvider
      navigate={navigateToDiagnostic}
      diagnostics={state.diagnostics}
      activeFilePaths={activeManifest ? getModuleFiles(activeManifest) : []}
    >
    <div className="flex h-screen flex-col overflow-hidden bg-white dark:bg-zinc-950">
      <TopBar
        workspace={state.workspace}
        activeManifest={activeManifest}
        workspaceSwitcher={{
          current: openWorkspaceKind,
          alwaysOfferBrowserWorkspace: openMode === "single",
          onOpenBrowserWorkspace: () => void switchWorkspace(openBrowserWorkspace()),
          onOpenWorkingCopy: (projectId) =>
            void switchWorkspace(openRoot(cloudWorkspaceRoot(projectId))),
          onOpenFolder: openMode === "chooser" ? handleOpen : undefined,
          onClose: closeWorkspace,
          mode: workspaceMode ? { current: workspaceMode, onChange: chooseWorkspaceMode } : undefined,
          resume:
            resumeOnLoad === undefined ? undefined : { auto: resumeOnLoad, onChange: chooseResumeOnLoad },
        }}
        onOpenNav={state.workspace ? () => setNavDrawerOpen(true) : undefined}
        onOpenSettings={() => setSettingsOpen(true)}
        onUndo={canUndo ? () => void handleUndo() : undefined}
        onRedo={canRedo ? () => void handleRedo() : undefined}
        canUndo={canUndo}
        canRedo={canRedo}
        session={runContext.session}
        onRetrySession={runContext.retrySession}
        importUpgrade={
          importUpgradesOffered && importUpgradeCount > 0
            ? {
                count: importUpgradeCount,
                busy: upgradingImports,
                onUpgrade: () => void handleUpgradeWorkspaceImports([...workspaceUpgrades.keys()]),
              }
            : undefined
        }
        onToggleChat={agentVisible ? agent.togglePanel : undefined}
        chatOpen={agent.panelOpen}
        teloLanguage={teloLanguage}
      />

      {error && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}
      {importLookupFailures.length > 0 && (
        <ImportLookupNotice
          failures={importLookupFailures}
          className="rounded-none border-b border-amber-200 px-4 py-2 dark:border-amber-900"
        />
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
        <RegionErrorBoundary
          region="sidebar"
          className="w-64 flex-none border-r border-zinc-200 dark:border-zinc-800"
        >
        <Sidebar
          workspace={state.workspace}
          activeModulePath={state.activeModulePath}
          activeTabId={state.activeTabId}
          fileTree={fileTree}
          expandedDirs={expandedDirsSet}
          onToggleDir={handleToggleDir}
          onOpenFile={(path) => {
            handleOpenFile(path);
            setNavDrawerOpen(false);
          }}
          onCreateFile={handleCreateFile}
          onCreateFolder={handleCreateFolder}
          onRenamePath={handleRenamePath}
          onDeletePath={handleDeletePath}
          onMovePath={handleMovePath}
          onOpenModule={(filePath) => {
            handleOpenModule(filePath);
            setNavDrawerOpen(false);
          }}
          onNewModule={setCreateModuleKind}
          onDeleteModule={handleDeleteModule}
          onRunModule={sessionMode ? handleRunModule : undefined}
          importUpgrades={
            importUpgradesOffered
              ? {
                  outdated: workspaceUpgrades,
                  busy: upgradingImports,
                  onUpgrade: (filePaths) => void handleUpgradeWorkspaceImports(filePaths),
                }
              : undefined
          }
          drawerOpen={navDrawerOpen}
          onDrawerOpenChange={setNavDrawerOpen}
        />
        </RegionErrorBoundary>
        {!state.workspace ? (
          <AppLifecyclePanel
            onOpen={handleOpen}
            onStartFromStarter={() => setCreateModuleKind("Application")}
            openMode={openMode}
            recentRootDir={persistedHint?.rootDir}
            onBuild={agentVisible ? buildInBrowserWorkspace : undefined}
          />
        ) : (
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {cloud.active && (
              <CloudProjectBar
                activeModule={
                  cloudActiveModule && {
                    name: cloudActiveModule.name,
                    modulePath: cloudActiveModule.modulePath,
                    kind: cloudActiveModule.kind,
                    // Published to run on the version it is edited against, as a run does.
                    telo: runVersionFor(teloLanguage, cloudActiveModule.filePath),
                  }
                }
                onOpenManifest={() => {
                  if (state.activeModulePath) handleOpenFile(state.activeModulePath);
                  setState((s) => ({ ...s, activeView: "source" as ViewId }));
                }}
                onOpenCloudView={() => setState((s) => ({ ...s, activeView: "cloud" as ViewId }))}
              />
            )}
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
              <RegionErrorBoundary region="open tab" resetKey={state.activeTabId}>
              {activeTab?.type === "file" ? (
                <FileEditor
                  // The epoch re-reads the file after a Cloud update rewrote it.
                  key={`${activeTab.path}#${cloud.filesEpoch}`}
                  filePath={activeTab.path}
                  readFile={readFileCb}
                  saveFile={saveFileCb}
                  readOnly={editingPaused !== null}
                />
              ) : activeTab?.type === "module" && viewData && viewEnvironment ? (
                <ViewContainer
                  activeView={state.activeView}
                  onChangeView={(view) => setState((s) => ({ ...s, activeView: view }))}
                  viewProps={{
                      readOnly: readOnlyReason !== null,
                      readOnlyReason,
                      viewData,
                      viewModelStatus,
                      onRetryViewModel:
                        viewModels && state.activeModulePath
                          ? () => viewModels.retry(state.activeModulePath!)
                          : undefined,
                      onPickConfiguration:
                        viewModels && state.activeModulePath
                          ? (configuration) => viewModels.configure(state.activeModulePath!, configuration)
                          : undefined,
                      onOpenSourceView: () =>
                        setState((s) => ({ ...s, activeView: "source" as ViewId })),
                      structuredModel,
                      moduleGraph: activeModuleGraph,
                      templateGraphFor: templateGraphByKind,
                      isEditableModule: isEditableModuleName,
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
                      cloud: cloud.active
                        ? { modulePath: cloudActiveModule?.modulePath ?? null }
                        : null,
                      environment: viewEnvironment,
                      run: {
                        // A workspace used only on this device runs nothing.
                        appPath: sessionMode ? activeAppPath : null,
                        editedTelo:
                          activeAppPath && teloLanguage?.kind === "running"
                            ? teloLanguage.statusOf(activeAppPath).version
                            : undefined,
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
              ) : hasNoWorkspaceModules(state.workspace) ? (
                <EmptyWorkspacePanel
                  onBuild={agentVisible ? buildInOpenWorkspace : undefined}
                  onStartFromStarter={
                    editingPaused === null ? () => setCreateModuleKind("Application") : undefined
                  }
                  build={
                    agentVisible && agentBuild
                      ? {
                          progress: agentBuild,
                          editorFile: agent.editorFile,
                          onStop: agent.stop,
                          onRetry: agent.canRetry ? agent.retry : undefined,
                          onShowConversation: agent.focusComposer,
                        }
                      : undefined
                  }
                />
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-zinc-50 px-6 text-center dark:bg-zinc-900">
                  <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Nothing open</p>
                  <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-500">
                    Open a file from the Explorer, or pick an Application or Library from the
                    sidebar.
                  </p>
                </div>
              )}
              </RegionErrorBoundary>
            </div>
          </div>
        )}
        {/* The panel owns its own width — the user drags it, and it persists. */}
        {agentVisible && agent.panelOpen && (
          <RegionErrorBoundary
            region="agent panel"
            className="w-80 flex-none border-l border-zinc-200 dark:border-zinc-800"
          >
            <AgentPanel className="shrink-0" />
          </RegionErrorBoundary>
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
      <CreateModuleDialog
        open={createModuleKind !== null}
        onOpenChange={(open) => !open && setCreateModuleKind(null)}
        kind={createModuleKind ?? "Application"}
        startersBaseUrl={resolveStartersBaseUrl(settings)}
        onCreate={createNewModule}
      />
      <WorkspaceModeDialog
        open={agentRootDir !== null && workspaceMode === null}
        onChoose={chooseWorkspaceMode}
      />
      <TermsGateDialog
        terms={termsGate?.terms ?? null}
        onAccept={() => {
          if (!termsGate) return;
          acceptTermsFor(termsGate.runnerId, termsGate.terms.version);
          const { resume } = termsGate;
          setTermsGate(null);
          // The session waiting on the agreement carries on opening; a Run the
          // gate interrupted is pressed again.
          if (termsGate.runnerId === settings.activeRunnerId) {
            runContext.acceptSessionTerms(termsGate.terms.version);
          }
          if (resume.kind === "run") void handleRunModuleRef.current(resume.filePath);
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
                {pendingImport.plan.published && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    This copy holds the published manifest alone — the browser cannot reach the
                    registry
                    {pendingImport.plan.published.uncopiedLayers.length > 0
                      ? ", so these payload layers are not copied:"
                      : "."}
                  </p>
                )}
                {pendingImport.plan.published &&
                  pendingImport.plan.published.uncopiedLayers.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                      {pendingImport.plan.published.uncopiedLayers.map((layer) => (
                        <li key={layer} className="break-all">
                          <code>{layer}</code>
                        </li>
                      ))}
                    </ul>
                  )}
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
    </CelFieldContext.Provider>
    </LanguageModelsContext.Provider>
  );
}
