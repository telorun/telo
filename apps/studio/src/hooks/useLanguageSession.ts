import { loader } from "@monaco-editor/react";
import type { Range } from "@telorun/analyzer";
import type { IPosition, IRange } from "monaco-editor";
import type { TeloStatus, VersionMarks } from "@telorun/language-host";
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { resolveHubUrl } from "../hub-search";
import { createManifestSources } from "../loader";
import { isInTauri } from "../loader/open";
import { bundledEngine } from "../language/bundled-engine";
import { CacheStorageEngineCache } from "../language/cache-storage-engine-cache";
import { emptyDiagnostics, withPublishedDiagnostics, withoutFile } from "../language/engine-diagnostics";
import { fileUriToPath } from "../language/file-uri";
import { LanguageSession } from "../language/language-session";
import type { TeloVersionSetting } from "../language/language-storage";
import type { LanguageModels } from "../language/language-models-context";
import type { MonacoApi } from "../language/lsp-to-monaco";
import { ModelProjections } from "../language/model-projections";
import { webWorkerEngineSpawner } from "../language/web-worker-engine-spawner";
import { WorkspaceModels } from "../language/workspace-models";
import type { AppSettings, EditorState, WorkspaceAdapter } from "../model";

/** The URI scheme of models showing part of a workspace document. */
const PROJECTION_SCHEME = "projection";

export type TeloLanguage =
  | {
      kind: "running";
      /** What the active module is edited against, or why nothing serves it. */
      status: TeloStatus;
      teloVersion: TeloVersionSetting;
      setTeloVersion(setting: TeloVersionSetting): Promise<void>;
      markVersions(): Promise<VersionMarks>;
      retry(): Promise<void>;
    }
  /** The workspace has no language session at all, and why. */
  | { kind: "failed"; failure: string };

/**
 * The workspace's language session: every manifest as a Monaco model, the
 * engine chosen for each module, and the diagnostics store fed from what the
 * engines publish — its only producer.
 */
export function useLanguageSession(options: {
  state: EditorState;
  setState: Dispatch<SetStateAction<EditorState>>;
  settings: AppSettings;
  workspaceAdapterRef: { current: WorkspaceAdapter | null };
  /** Opens a workspace file at a range — where a go-to-definition lands when
   *  its target is not the file on screen. */
  navigate(filePath: string, range?: Range): void;
  /** A message the engine asks to show the user. */
  onShowMessage(message: string): void;
}): { language: TeloLanguage | null; models: LanguageModels | null } {
  const { state, setState, settings, workspaceAdapterRef, navigate, onShowMessage } = options;
  const [monaco, setMonaco] = useState<MonacoApi | null>(null);
  const models = useMemo<LanguageModels | null>(
    () => (monaco ? { monaco, projections: new ModelProjections(PROJECTION_SCHEME) } : null),
    [monaco],
  );
  const [workspaceModels, setWorkspaceModels] = useState<WorkspaceModels | null>(null);
  const [session, setSession] = useState<LanguageSession | null>(null);
  const [status, setStatus] = useState<TeloStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [teloVersion, setTeloVersionState] = useState<TeloVersionSetting>("auto");
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const showRef = useRef(onShowMessage);
  showRef.current = onShowMessage;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const documentsRef = useRef(state.workspace?.documents);
  documentsRef.current = state.workspace?.documents;

  useEffect(() => {
    let cancelled = false;
    loader.init().then(
      (instance) => {
        if (!cancelled) setMonaco(instance as unknown as MonacoApi);
      },
      (error: unknown) => {
        if (!cancelled) setFailure(`the Monaco editor could not be loaded: ${errorText(error)}`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Monaco opens no other model by itself: a jump into another workspace file
  // goes through the app's navigation, which activates its module and reveals
  // the range.
  useEffect(() => {
    if (!monaco) return;
    const opener = monaco.editor.registerEditorOpener({
      openCodeEditor(source, resource, selectionOrPosition) {
        if (resource.scheme !== "file") return false;
        navigateRef.current(fileUriToPath(resource.toString()), selectionOrPosition && toRange(selectionOrPosition));
        return true;
      },
    });
    return () => opener.dispose();
  }, [monaco]);

  const rootDir = state.workspace?.rootDir;
  useEffect(() => {
    if (!models || !rootDir) return;
    const { monaco } = models;
    let live = true;
    let started: LanguageSession | undefined;
    let statusListener: { dispose(): void } | undefined;
    setState((s) => ({ ...s, diagnostics: emptyDiagnostics() }));
    setFailure(null);
    const documentModels = new WorkspaceModels(monaco);
    documentModels.sync(documentsRef.current ?? new Map());
    setWorkspaceModels(documentModels);

    LanguageSession.start({
      monaco,
      rootDir,
      workspace: () => {
        const adapter = workspaceAdapterRef.current;
        if (!adapter) throw new Error("no workspace is open.");
        return adapter;
      },
      ...(isInTauri() ? {} : { confineTo: rootDir }),
      hubUrl: () => resolveHubUrl(settingsRef.current.hubUrl),
      manifestSources: () => createManifestSources(settingsRef.current),
      spawner: webWorkerEngineSpawner,
      engineCache: new CacheStorageEngineCache(),
      bundled: bundledEngine(),
      storage: window.localStorage,
      projections: models.projections,
      onDiagnostics: (uri, diagnostics) => {
        if (live) setState((s) => ({ ...s, diagnostics: withPublishedDiagnostics(s.diagnostics, uri, diagnostics) }));
      },
      onMessage: (type, message, shown) => {
        if (!live) return;
        if (shown) showRef.current(message);
        else if (type === 1) console.error(message);
        else if (type === 2) console.warn(message);
        else console.info(message);
      },
    }).then(
      (s) => {
        if (!live) {
          void s.dispose();
          return;
        }
        started = s;
        statusListener = s.onStatus(setStatus);
        setStatus(s.status());
        setTeloVersionState(s.teloVersion);
        setSession(s);
      },
      (error: unknown) => {
        if (live) setFailure(`the telo language tooling could not start: ${errorText(error)}`);
      },
    );

    return () => {
      live = false;
      statusListener?.dispose();
      setSession(null);
      setStatus(null);
      setWorkspaceModels(null);
      started?.dispose().catch((error) => console.error(`telo: could not stop the language session: ${errorText(error)}`));
      documentModels.dispose();
    };
    // The session is per workspace; the adapter and settings are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, rootDir]);

  const documents = state.workspace?.documents;
  useEffect(() => {
    if (!workspaceModels || !documents) return;
    const removed = workspaceModels.sync(documents);
    if (removed.length) {
      setState((s) => ({ ...s, diagnostics: removed.reduce(withoutFile, s.diagnostics) }));
    }
  }, [workspaceModels, documents, setState]);

  const activeModulePath = state.activeModulePath;
  useEffect(() => {
    session?.setActiveDocument(activeModulePath ?? undefined);
  }, [session, activeModulePath]);

  if (failure) return { language: { kind: "failed", failure }, models };
  if (!session || !status) return { language: null, models };
  return {
    models,
    language: {
      kind: "running",
      status,
      teloVersion,
      setTeloVersion: async (setting) => {
        setTeloVersionState(setting);
        await session.setTeloVersion(setting);
      },
      markVersions: () => session.markVersions(),
      retry: () => session.retry(),
    },
  };
}

function toRange(target: IRange | IPosition): Range {
  if ("startLineNumber" in target) {
    return {
      start: { line: target.startLineNumber - 1, character: target.startColumn - 1 },
      end: { line: target.endLineNumber - 1, character: target.endColumn - 1 },
    };
  }
  const at = { line: target.lineNumber - 1, character: target.column - 1 };
  return { start: at, end: at };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
