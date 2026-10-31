import type { ManifestSource } from "@telorun/analyzer";
import {
  TeloMethod,
  type CelCompletionParams,
  type ViewModel,
  type ViewModelChangedParams,
} from "@telorun/editor-protocol";
import {
  HubClient,
  LanguageRouter,
  canonicalUri,
  createInProcessTransports,
  type BundledEngine,
  type EngineCache,
  type EngineSpawner,
  type TeloStatus,
  type VersionMarks,
} from "@telorun/language-host";
import type { CompletionItem, Diagnostic } from "vscode-languageserver-protocol";
import type { WorkspaceAdapter } from "../model";
import { pathToFileUri } from "./file-uri";
import {
  localCatalogCache,
  localResolutionStore,
  pinOf,
  readTeloVersionSetting,
  writeTeloVersionSetting,
  type TeloVersionSetting,
} from "./language-storage";
import type { MonacoApi } from "./lsp-to-monaco";
import type { ModelProjections } from "./model-projections";
import { MonacoLspBridge } from "./monaco-lsp-bridge";
import { remoteManifestReader } from "./remote-manifest-reader";
import { WorkspaceFileSystem } from "./workspace-file-system";
import { MANIFEST_LANGUAGE } from "./workspace-models";

export interface LanguageSessionOptions {
  monaco: MonacoApi;
  rootDir: string;
  workspace: () => WorkspaceAdapter;
  /** Bounds a workspace whose paths are virtual (see `WorkspaceFileSystem`). */
  confineTo?: string;
  /** The hub studio's settings name, read per lookup. */
  hubUrl: () => string;
  /** The manifest sources studio's settings add, read per remote read. */
  manifestSources: () => ManifestSource[];
  spawner: EngineSpawner;
  engineCache: EngineCache;
  bundled: BundledEngine;
  /** Where the `telo.version` setting, this workspace's Auto resolutions and
   *  the engine catalog are kept. */
  storage: Storage;
  /** Models showing part of a workspace document, served through it. */
  projections?: ModelProjections;
  fetch?: typeof globalThis.fetch;
  onDiagnostics(uri: string, diagnostics: Diagnostic[]): void;
  onMessage(type: 1 | 2 | 3 | 4, message: string, shown: boolean): void;
}

/** `telo/celCompletion` for the module at `modulePath`. */
export type CelFieldCompletionParams = Omit<CelCompletionParams, "owner"> & { modulePath: string };

/**
 * One workspace's language tooling: the router choosing and running engines,
 * and the Monaco bridge speaking to it. Every manifest model is a document the
 * engines analyse; every diagnostic studio shows comes from here, and so does
 * the view model each module's structured views read.
 *
 * A module is named by its workspace path; as an owner on the wire it is the
 * canonical URI of that path (`ownerOf`), which is also how a
 * `telo/viewModelChanged` names it.
 */
export class LanguageSession {
  private readonly viewModelListeners = new Set<(params: ViewModelChangedParams) => void>();

  private constructor(
    private readonly router: LanguageRouter,
    private readonly bridge: MonacoLspBridge,
    private readonly options: LanguageSessionOptions,
  ) {
    bridge.onNotification(TeloMethod.viewModelChanged, (params: ViewModelChangedParams) => {
      for (const listener of [...this.viewModelListeners]) listener(params);
    });
  }

  static async start(options: LanguageSessionOptions): Promise<LanguageSession> {
    const transports = createInProcessTransports();
    const router = new LanguageRouter({
      client: transports.server,
      files: new WorkspaceFileSystem(options.workspace, options.confineTo),
      remote: remoteManifestReader(options.manifestSources),
      hub: new HubClient({ url: options.hubUrl, ...(options.fetch ? { fetch: options.fetch } : {}) }),
      spawner: options.spawner,
      engineCache: options.engineCache,
      catalogCache: localCatalogCache(options.storage),
      resolutions: localResolutionStore(options.rootDir, options.storage),
      bundled: options.bundled,
      pin: pinOf(readTeloVersionSetting(options.rootDir, options.storage)),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const bridge = await MonacoLspBridge.start({
      monaco: options.monaco,
      transports: transports.client,
      documents: { language: MANIFEST_LANGUAGE, scheme: "file" },
      ...(options.projections ? { projections: options.projections } : {}),
      markerOwner: "telo",
      clientName: "telo studio",
      onDiagnostics: options.onDiagnostics,
      onMessage: options.onMessage,
    });
    return new LanguageSession(router, bridge, options);
  }

  get teloVersion(): TeloVersionSetting {
    return readTeloVersionSetting(this.options.rootDir, this.options.storage);
  }

  /** Store `telo.version` for this workspace and move every module onto it. */
  async setTeloVersion(setting: TeloVersionSetting): Promise<void> {
    writeTeloVersionSetting(this.options.rootDir, setting, this.options.storage);
    await this.router.setPin(pinOf(setting));
  }

  /** The document the editor shows; the status speaks for it. */
  setActiveDocument(path: string | undefined): void {
    this.router.setActiveDocument(path === undefined ? undefined : pathToFileUri(path));
  }

  status(): TeloStatus {
    return this.router.status();
  }

  /** What the document at `path` is edited against. */
  statusOf(path: string): TeloStatus {
    return this.router.statusOf(pathToFileUri(path));
  }

  onStatus(listener: (status: TeloStatus) => void): { dispose(): void } {
    return this.router.onStatus(listener);
  }

  markVersions(): Promise<VersionMarks> {
    return this.router.markVersions();
  }

  retry(): Promise<void> {
    return this.router.retry();
  }

  /** The canonical owner URI of the module at `modulePath`. */
  ownerOf(modulePath: string): string {
    return canonicalUri(pathToFileUri(modulePath));
  }

  /** Whether the engine serving the module serves structured editing;
   *  `undefined` while no running engine serves it. */
  supportsViewModel(modulePath: string): boolean | undefined {
    return this.router.supportsViewModel(this.ownerOf(modulePath));
  }

  /** The version of the open document at canonical `uri` last sent to the
   *  engines — the number a view model's `documents` names; undefined when no
   *  model of it is open. */
  documentVersion(uri: string): number | undefined {
    for (const model of this.options.monaco.editor.getModels()) {
      if (canonicalUri(model.uri.toString()) === uri) return model.getVersionId();
    }
    return undefined;
  }

  /** The module's view model, or `null` when its engine is not analysing it.
   *  `configuration` is the assignment its choices are drawn in. */
  viewModel(modulePath: string, configuration?: Record<string, unknown>): Promise<ViewModel | null> {
    return this.bridge.sendRequest<ViewModel | null>(TeloMethod.viewModel, {
      owner: this.ownerOf(modulePath),
      ...(configuration ? { configuration } : {}),
    });
  }

  /** Completion inside a CEL value typed into a form field; a `textEdit`
   *  range is a line/character range in `text`. */
  celCompletion({ modulePath, ...field }: CelFieldCompletionParams): Promise<CompletionItem[]> {
    const params: CelCompletionParams = { owner: this.ownerOf(modulePath), ...field };
    return this.bridge.sendRequest<CompletionItem[]>(TeloMethod.celCompletion, params);
  }

  /** Every `telo/viewModelChanged`, its `owner` canonical. */
  onViewModelChanged(listener: (params: ViewModelChangedParams) => void): { dispose(): void } {
    this.viewModelListeners.add(listener);
    return { dispose: () => void this.viewModelListeners.delete(listener) };
  }

  dispose(): Promise<void> {
    return this.bridge.dispose();
  }
}
