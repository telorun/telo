import {
  TELO_EDITOR_PROTOCOL,
  TELO_SERVER_NAME,
  TeloMethod,
  type RequirementsParams,
  type TeloHostRequests,
} from "@telorun/editor-protocol";
import {
  ResponseError,
  createMessageConnection,
  type CancellationToken,
  type ClientCapabilities,
  type Diagnostic,
  type FileEvent,
  type FileSystemWatcher,
  type InitializeParams,
  type InitializeResult,
  type MessageConnection,
  type Registration,
  type SemanticTokensLegend,
  type ServerCapabilities,
  type Unregistration,
} from "vscode-languageserver-protocol";
import { canonicalUri } from "./canonical-uri.js";
import {
  EDITOR_FEATURES,
  RESOLVES,
  advertises,
  featureOptions,
  isIdentityRemap,
  legendRemap,
  remapTokens,
  type EditorFeature,
  type FeatureOptions,
} from "./editor-capabilities.js";
import { EngineIntegrityError } from "./engine-archive.js";
import { EngineUnavailableError, loadEngine } from "./engine-supply.js";
import { hostAnswers } from "./host-answers.js";
import type {
  BundledEngine,
  EngineCache,
  EngineSpawner,
  HostFileSystem,
  HostServices,
  RemoteReader,
  ResolutionStore,
  SpawnedEngine,
  StoredResolutions,
} from "./host-seams.js";
import type { HubClient } from "./hub-client.js";
import { ensureMessageRuntime, portTransports, type MessageTransports } from "./message-transports.js";
import { intervalAccepts, parseEngineIdentity } from "./plain-version.js";
import { selectVersion, type SelectionReason } from "./select-version.js";
import {
  knownVersions,
  loadCatalog,
  readCachedCatalog,
  type CatalogCache,
  type CatalogReading,
  type UnofferedReason,
  type VersionCatalog,
} from "./version-catalog.js";
import { watcherMatches } from "./watcher-glob.js";

/** How long an engine may take to answer `initialize` before it counts as
 *  failed. Nothing after the handshake is timed. */
export const HANDSHAKE_TIMEOUT_MS = 30_000;

/** A state in which the editor runs no engine for a document, or runs one
 *  that cannot satisfy it — always named, never papered over. */
export type StatusError =
  /** The chosen version is neither cached nor downloadable. */
  | { kind: "offline-uncached"; version: string; message: string }
  /** The chosen engine failed verification: its download or cached copy, or
   *  its handshake. `version` is absent for a bundled engine that never
   *  identified itself. */
  | { kind: "engine-refused"; version?: string; message: string }
  /** The chosen engine could not run: it threw while loading, raised an
   *  uncaught error, exited, or did not answer its handshake in time. */
  | { kind: "engine-failed"; version?: string; message: string }
  /** `telo.version` names a version this editor does not offer. */
  | { kind: "pin-unoffered"; pin: string; reason: UnofferedReason | "unpublished"; message: string }
  /** No known version satisfies the closure's `requires: telo:` ranges. */
  | { kind: "nothing-satisfies"; ranges: string[]; message: string };

/** What a host shows for the active document: "Telo X", pinned or not, what
 *  chose X, whether its engine is still starting, or the error state. */
export interface TeloStatus {
  document?: string;
  owner?: string;
  /** The engine identity serving the document; absent when none can. */
  version?: string;
  pinned: boolean;
  /** The engine is loading or has not answered its handshake yet. */
  starting: boolean;
  reason?: SelectionReason;
  error?: StatusError;
}

/** One row of a version picker. */
export interface MarkedVersion {
  version: string;
  bundled: boolean;
  cached: boolean;
  /** Whether every `requires: telo:` range of the active module's closure
   *  accepts it; absent when the active document has no analysed owner. */
  accepted?: boolean;
}

export interface VersionMarks {
  /** What "Auto" resolves to for the active document. */
  auto?: string;
  /** Every known version, newest first. */
  versions: MarkedVersion[];
}

export interface RouterOptions {
  /** The router's end of the editor's LSP connection. */
  client: MessageTransports;
  /** The workspace, for `file:` reads, existence checks and listings. */
  files: HostFileSystem;
  /** Every non-`file:` read. */
  remote: RemoteReader;
  hub: HubClient;
  spawner: EngineSpawner;
  engineCache: EngineCache;
  catalogCache: CatalogCache;
  /** Auto resolutions of this workspace, so a module reopens on its engine. */
  resolutions: ResolutionStore;
  bundled: BundledEngine;
  /** `telo.version` when it names a version; absent for Auto. */
  pin?: string;
  fetch?: typeof globalThis.fetch;
}

const SPEAKS = [TELO_EDITOR_PROTOCOL];
/** Where a resolvable item carries the engine that produced it. */
const PRODUCER = "telo.engine";

/** An engine refused at its handshake. */
class EngineRefusedError extends Error {}
/** An engine that stopped working, or never started. */
class EngineFailedError extends Error {}

interface EngineSlot {
  bundled: boolean;
  /** The identity it was asked for (a downloaded engine); absent for the
   *  bundled one until its handshake names it. */
  identity?: string;
  /** Resolves once the engine answered `initialize` and passed verification;
   *  rejects when it could not be loaded, refused or failed. */
  ready: Promise<MessageConnection>;
  settled: boolean;
  spawned?: SpawnedEngine;
  initializeResult?: InitializeResult;
  /** Rejects when the engine fails or stops; every request races it, so none
   *  outlives the engine it was sent to. */
  gone: Promise<never>;
  end(error: Error): void;
  ended?: "failed" | "stopped";
  /** Serializes everything sent to the engine, so a change never overtakes
   *  the open it follows. */
  queue: Promise<unknown>;
  /** What it published, by canonical URI, with the URI as it wrote it. */
  diagnostics: Map<string, { uri: string; diagnostics: Diagnostic[] }>;
  /** Features it registered dynamically, by its registration id. */
  dynamic: Map<string, { feature: EditorFeature; options: FeatureOptions }>;
  /** File watchers it registered, by its registration id. */
  watchers: Map<string, FileSystemWatcher[]>;
  /** Registrations of methods the router does not own, passed to the editor
   *  and withdrawn when the engine goes. */
  forwarded: Map<string, string>;
}

interface OpenDocument {
  /** The URI as the editor spelled it — what the engines are told. */
  uri: string;
  languageId: string;
  version: number;
  text: string;
  /** The identity of the engine the document is open in, when any. */
  engine?: string;
}

interface OwnerState {
  requirements?: RequirementsParams;
  /** The engine serving the owner. */
  current?: string;
  /** The documents the owner claims — its last requirements', or the stored
   *  entry's before its first analysis. */
  documents: string[];
  /** Restored from the workspace's stored resolutions and not analysed since:
   *  an engine that then fails to load sends it back to the bundled one. */
  restored?: boolean;
  reason?: SelectionReason;
  /** Requirement sets (with the versions known when they were read) that
   *  already moved the owner, so two engines reading a closure differently
   *  cannot bounce it between them. */
  movedFor: Set<string>;
}

type Target = { version: string } | { error: StatusError } | { starting: true };

const TEXT_DOCUMENT_SYNC = new Set(["textDocument/didOpen", "textDocument/didChange", "textDocument/didClose"]);

/**
 * One LSP endpoint in front of many engines.
 *
 * The editor speaks to the router as to one language server; the router runs
 * one engine per telo version in use and routes each document to the engine of
 * the owner module that claims it in `telo/requirements` (or in the workspace's
 * stored resolution before its first analysis; an unclaimed document goes to
 * the bundled engine). Every URI is compared in its canonical form
 * (`@telorun/editor-protocol` § URIs), never rewritten.
 *
 * The router owns what the editor sees of its engines: one registration per
 * feature carrying the union of what the running engines advertise, each
 * request sent only to an engine that advertised it, a resolve sent back to
 * the engine that produced the item, one registration per distinct file
 * watcher. A document open in the editor, or claimed by an owner, shows only
 * its serving engine's diagnostics; any other file shows what every running
 * engine publishes for it.
 *
 * Which engine an owner runs on is `selectVersion`'s answer. A module starts on
 * the engine it last resolved to and moves when its engine's `telo/requirements`
 * resolves elsewhere — once per requirement set and set of known versions. A
 * version that cannot run (not cached and unreachable, refused by verification,
 * failed, a pin this editor does not offer) leaves its documents without an
 * engine and says so in the status; no other engine is substituted.
 */
export class LanguageRouter {
  private readonly client: MessageConnection;
  private readonly services: HostServices;
  private bundled: EngineSlot | undefined;
  /** Downloaded engines, by identity. */
  private readonly engines = new Map<string, EngineSlot>();
  private readonly documents = new Map<string, OpenDocument>();
  private readonly owners = new Map<string, OwnerState>();
  private readonly documentOwner = new Map<string, string>();
  private resolutionsWritten: Promise<void> = Promise.resolve();
  private resolutionsRestored: Promise<void> | undefined;
  private readonly engineErrors = new Map<string, StatusError>();
  /** Why the bundled engine never identified itself, when it did not. */
  private bundledError: StatusError | undefined;
  /** The identity the bundled engine last named itself by. A restarted
   *  bundled engine is still the engine of that identity until its own
   *  handshake says otherwise — never one to look up or download. */
  private bundledIdentity: string | undefined;
  /** What the editor currently shows per canonical URI. */
  private readonly shown = new Map<string, { uri: string; key: string }>();
  private readonly statusListeners = new Set<(status: TeloStatus) => void>();
  private reading: CatalogReading = { offered: [], unoffered: {}, source: "bundled" };
  private registryRead: Promise<void> | undefined;
  private initializeParams: InitializeParams | undefined;
  private clientCapabilities: ClientCapabilities = {};
  private clientInitialized = false;
  /** Registrations the router holds with the editor: per feature, and per
   *  distinct watcher. */
  private readonly featureRegistrations = new Map<string, { id: string; key: string; options: FeatureOptions }>();
  private readonly watcherRegistrations = new Map<string, string>();
  private registrationQueue: Promise<void> = Promise.resolve();
  private nextRegistration = 1;
  private pin: string | undefined;
  private active: string | undefined;

  constructor(private readonly options: RouterOptions) {
    ensureMessageRuntime();
    this.pin = options.pin;
    this.services = hostAnswers(options.files, options.remote, options.hub);
    this.client = createMessageConnection(options.client.reader, options.client.writer);
    this.client.onRequest((method, params, token) => this.fromClient(method, params, token));
    this.client.onNotification((method, params) => this.clientNotification(method, params));
    this.client.listen();
  }

  // --- host API --------------------------------------------------------------

  onStatus(listener: (status: TeloStatus) => void): { dispose(): void } {
    this.statusListeners.add(listener);
    return { dispose: () => this.statusListeners.delete(listener) };
  }

  /** The document the editor shows; the status speaks for it. */
  setActiveDocument(uri: string | undefined): void {
    this.active = uri;
    this.emitStatus();
  }

  status(): TeloStatus {
    const uri = this.active;
    const key = uri === undefined ? undefined : canonicalUri(uri);
    const owner = key === undefined ? undefined : this.documentOwner.get(key);
    const state = owner === undefined ? undefined : this.owners.get(owner);
    const target = key === undefined ? this.defaultTarget() : this.targetOf(key);
    const pinned = this.pin !== undefined;
    const base = { document: uri, owner, pinned };
    if ("error" in target) return { ...base, starting: false, error: target.error };
    if ("starting" in target) return { ...base, starting: true };
    const reason: SelectionReason = pinned ? { kind: "pinned" } : (state?.reason ?? { kind: "bundled" });
    const failed = this.engineErrors.get(target.version);
    const error: StatusError | undefined =
      failed ??
      (reason.kind === "unsatisfiable"
        ? {
            kind: "nothing-satisfies",
            ranges: reason.ranges,
            message:
              `no available telo satisfies this module's requires: telo: ranges ` +
              `(${reason.ranges.join("; ")}); telo ${target.version} reports the refusing module.`,
          }
        : undefined);
    const slot = failed ? undefined : this.slotOf(target.version);
    return {
      ...base,
      ...(failed ? {} : { version: target.version }),
      starting: slot !== undefined && !slot.settled,
      reason,
      ...(error ? { error } : {}),
    };
  }

  /** Every known version marked for a picker against the active document. */
  async markVersions(): Promise<VersionMarks> {
    await this.registryRead;
    const catalog = this.catalog();
    const owner = this.active === undefined ? undefined : this.documentOwner.get(canonicalUri(this.active));
    const requirements = owner === undefined ? undefined : this.owners.get(owner)?.requirements;
    const auto = catalog.bundled === undefined ? undefined : selectVersion({ catalog, requirements });
    const versions = await Promise.all(
      knownVersions(catalog).map(async (version) => ({
        version,
        bundled: version === catalog.bundled,
        cached: version === catalog.bundled || (await this.options.engineCache.has(version)),
        ...(requirements
          ? { accepted: requirements.ranges.every((r) => intervalAccepts(r.interval, version)) }
          : {}),
      })),
    );
    return { ...(auto && "version" in auto ? { auto: auto.version } : {}), versions };
  }

  /** `telo.version` changed: `undefined` is Auto. */
  async setPin(pin: string | undefined): Promise<void> {
    this.pin = pin;
    await this.reconcile();
  }

  /** Start again every engine that failed or could not be loaded — the bundled
   *  one included — and read the catalog again. */
  async retry(): Promise<void> {
    this.engineErrors.clear();
    if (this.bundled === undefined || this.bundled.ended === "failed" || this.bundledError) {
      this.bundledError = undefined;
      this.bundled = this.startBundled();
      await this.bundled.ready.catch(() => undefined);
    }
    this.readRegistry();
    await this.registryRead;
    await this.reconcile();
  }

  // --- catalog and selection -------------------------------------------------

  /** The catalog with the bundled engine's identity once its handshake named
   *  it — kept when that engine later fails, which is the status's error. */
  private catalog(): VersionCatalog {
    const bundled = this.bundledIdentity;
    return { ...this.reading, ...(bundled ? { bundled } : {}) };
  }

  /** The registry's catalog, read in the background and bounded; when it
   *  arrives every owner is chosen for again. Only an engine download waits
   *  for it. */
  private readRegistry(): void {
    this.registryRead = loadCatalog({
      speaks: SPEAKS,
      cache: this.options.catalogCache,
      fetch: this.options.fetch,
      warn: (message) => this.log(2, message),
    })
      .then(async (reading) => {
        this.reading = reading;
        const moved = [...this.owners.values()].filter((state) => this.select(state));
        if (moved.length > 0) this.persistResolutions();
        await this.reconcile();
      })
      .catch((error) => this.log(1, `telo: could not read the engine catalog: ${errorText(error)}`));
  }

  /**
   * The workspace's stored Auto resolutions, read once with the catalog and
   * before the first document is routed. An entry is honoured only when its
   * version is known and runnable without a download (bundled, or cached);
   * anything else is dropped and its owner starts on the bundled engine.
   */
  private async restoreResolutions(): Promise<void> {
    const stored = await this.options.resolutions.read();
    const catalog = this.catalog();
    const known = new Set(knownVersions(catalog));
    for (const [owner, entry] of Object.entries(stored?.owners ?? {})) {
      const runnable =
        known.has(entry.version) &&
        (entry.version === catalog.bundled || (await this.options.engineCache.has(entry.version)));
      if (!runnable) continue;
      const documents = entry.documents.map(canonicalUri);
      this.owners.set(canonicalUri(owner), {
        current: entry.version,
        documents,
        restored: true,
        movedFor: new Set(),
      });
      for (const document of documents) this.documentOwner.set(document, canonicalUri(owner));
    }
  }

  /** Persist every owner's Auto resolution. Writes are serialized; a failed one
   *  is reported and the next change writes again. Nothing is written under a
   *  pin, which is not an Auto resolution. */
  private persistResolutions(): void {
    if (this.pin !== undefined) return;
    const snapshot: StoredResolutions = { owners: {} };
    for (const [owner, state] of this.owners) {
      if (state.current !== undefined) {
        snapshot.owners[owner] = { version: state.current, documents: state.documents };
      }
    }
    this.resolutionsWritten = this.resolutionsWritten
      .then(() => this.options.resolutions.write(snapshot))
      .catch((error) => this.log(1, `telo: could not store this workspace's telo versions: ${errorText(error)}`));
  }

  /** Choose the owner's engine from its requirements, moving it at most once
   *  per requirement set and set of known versions; whether it moved. Auto
   *  only, and only once the bundled engine has named itself. */
  private select(state: OwnerState): boolean {
    const catalog = this.catalog();
    if (this.pin !== undefined || catalog.bundled === undefined || !state.requirements) return false;
    const outcome = selectVersion({ catalog, requirements: state.requirements });
    if (!("version" in outcome)) return false;
    state.reason = outcome.reason;
    const key = JSON.stringify([state.requirements.ranges, knownVersions(catalog)]);
    if (outcome.version === state.current || state.movedFor.has(key)) return false;
    state.movedFor.add(key);
    state.current = outcome.version;
    return true;
  }

  private pinnedTarget(pin: string): Target {
    const outcome = selectVersion({ catalog: this.catalog(), pin });
    if ("version" in outcome) return { version: outcome.version };
    const { reason } = outcome.refused;
    return {
      error: {
        kind: "pin-unoffered",
        pin,
        reason,
        message: `telo.version is ${pin}, which this editor does not offer: ${describeUnoffered(reason)}.`,
      },
    };
  }

  private defaultTarget(): Target {
    if (this.pin !== undefined) return this.pinnedTarget(this.pin);
    const bundled = this.catalog().bundled;
    if (bundled !== undefined) return { version: bundled };
    if (this.bundledError) return { error: this.bundledError };
    return { starting: true };
  }

  /** The engine a document belongs on, by canonical URI. */
  private targetOf(key: string): Target {
    if (this.pin !== undefined) return this.pinnedTarget(this.pin);
    const owner = this.documentOwner.get(key);
    const current = owner === undefined ? undefined : this.owners.get(owner)?.current;
    return current !== undefined ? { version: current } : this.defaultTarget();
  }

  // --- engines ---------------------------------------------------------------

  private newSlot(bundled: boolean, identity?: string): EngineSlot {
    let end!: (error: Error) => void;
    const gone = new Promise<never>((_, reject) => (end = reject));
    gone.catch(() => undefined);
    const slot: EngineSlot = {
      bundled,
      ...(identity !== undefined ? { identity } : {}),
      ready: undefined as unknown as Promise<MessageConnection>,
      settled: false,
      gone,
      end,
      queue: Promise.resolve(),
      diagnostics: new Map(),
      dynamic: new Map(),
      watchers: new Map(),
      forwarded: new Map(),
    };
    return slot;
  }

  private startBundled(): EngineSlot {
    const slot = this.newSlot(true);
    slot.ready = this.options.bundled.load().then((bytes) => this.handshake(slot, bytes));
    this.watch(slot);
    return slot;
  }

  /** The slot running `version`, when one does. */
  private slotOf(version: string): EngineSlot | undefined {
    if (version === this.bundledIdentity) return this.bundled && !this.bundled.ended ? this.bundled : undefined;
    return this.engines.get(version);
  }

  /** The slot for `version`, started when none runs it. */
  private engine(version: string): EngineSlot {
    if (version === this.bundledIdentity && this.bundled) return this.bundled;
    const existing = this.slotOf(version);
    if (existing) return existing;
    const slot = this.newSlot(false, version);
    this.engines.set(version, slot);
    slot.ready = this.download(version).then((bytes) => this.handshake(slot, bytes));
    this.watch(slot);
    return slot;
  }

  private async download(version: string): Promise<Uint8Array> {
    // Only a download waits for the registry: a cached engine runs at once.
    if (!(await this.options.engineCache.has(version))) await this.registryRead;
    return loadEngine({
      version,
      catalog: this.reading,
      cache: this.options.engineCache,
      speaks: SPEAKS,
      fetch: this.options.fetch,
      warn: (message) => this.log(2, message),
    });
  }

  /** Run engine code, answer its requests, and verify its handshake: it names
   *  itself telo, speaks a generation this host speaks, and a downloaded
   *  engine reports exactly the version it was downloaded as. */
  private async handshake(slot: EngineSlot, bytes: Uint8Array): Promise<MessageConnection> {
    if (!this.initializeParams) throw new Error("an engine was started before the editor initialized.");
    slot.spawned = this.options.spawner.spawn({ ...(slot.identity !== undefined ? { version: slot.identity } : {}), bytes });
    slot.spawned.onFailure((reason) => this.failed(slot, reason));
    const { reader, writer } = portTransports(slot.spawned.port);
    const connection = createMessageConnection(reader, writer);
    connection.onRequest((method, params, token) => this.fromEngine(slot, method, params, token));
    connection.onNotification((method, params) => this.engineNotification(slot, method, params));
    connection.listen();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>(() => {
      timer = setTimeout(
        () => this.failed(slot, `it did not answer initialize within ${HANDSHAKE_TIMEOUT_MS / 1000} s`),
        HANDSHAKE_TIMEOUT_MS,
      );
    });
    let result: InitializeResult;
    try {
      result = await Promise.race([
        connection.sendRequest("initialize", this.initializeParams) as Promise<InitializeResult>,
        slot.gone,
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
    const name = result.serverInfo?.name;
    const version = result.serverInfo?.version;
    const protocol = (result.capabilities?.experimental as { telo?: { protocol?: unknown } } | undefined)?.telo
      ?.protocol;
    const refusal =
      name !== TELO_SERVER_NAME
        ? `it names itself ${JSON.stringify(name)}, not ${JSON.stringify(TELO_SERVER_NAME)}`
        : typeof protocol !== "number" || !SPEAKS.includes(protocol)
          ? `it speaks editor protocol ${JSON.stringify(protocol)}, which this editor does not (it speaks ${SPEAKS.join(", ")})`
          : typeof version !== "string" || !parseEngineIdentity(version)
            ? `it reports ${JSON.stringify(version)} as its version, which is not a telo version`
            : slot.identity !== undefined && version !== slot.identity
              ? `it was downloaded as telo ${slot.identity} but reports ${version}`
              : undefined;
    if (refusal) {
      throw new EngineRefusedError(`the ${slotName(slot)} engine was refused at its handshake: ${refusal}.`);
    }
    slot.identity = version;
    if (slot.bundled) this.bundledIdentity = version;
    slot.initializeResult = result;
    // An engine that dies while `initialized` is being sent never counts as
    // running: the failure it reported fails the handshake.
    await Promise.race([connection.sendNotification("initialized", {}), slot.gone]);
    slot.settled = true;
    return connection;
  }

  /** Follow a slot's startup: on success its features join the editor's; on
   *  failure the documents waiting for it are left without an engine. */
  private watch(slot: EngineSlot): void {
    slot.queue = slot.ready.catch(() => undefined);
    slot.ready.then(
      () => {
        this.syncRegistrations();
        this.emitStatus();
      },
      (error) => this.unavailable(slot, error),
    );
  }

  /** The engine failed — while starting or at any time after. */
  private failed(slot: EngineSlot, reason: string): void {
    if (slot.ended) return;
    const error = new EngineFailedError(`the ${slotName(slot)} engine failed: ${reason}`);
    if (!slot.settled) {
      // The startup's own rejection reports it.
      slot.end(error);
      return;
    }
    this.retire(slot, error);
  }

  /** A slot that never became ready. */
  private unavailable(slot: EngineSlot, error: unknown): void {
    if (slot.ended === "stopped") return;
    this.retire(slot, error instanceof Error ? error : new Error(String(error)));
  }

  /** Take a failed engine out of service: its pending requests rejected, its
   *  documents left engine-less, its registrations and diagnostics withdrawn,
   *  the failure logged and shown. */
  private retire(slot: EngineSlot, error: Error): void {
    if (slot.ended) return;
    slot.ended = "failed";
    slot.end(error);
    slot.spawned?.terminate();
    const message = error.message;
    const version = this.identityOf(slot);
    if (!slot.bundled && version !== undefined) this.engines.delete(version);

    // A module restored from the workspace's last session, and not analysed
    // since, goes back to the bundled engine for its first analysis — the
    // stored choice was a starting point, not a requirement.
    const bundled = this.catalog().bundled;
    const restored = slot.bundled
      ? []
      : [...this.owners.values()].filter(
          (o) => o.restored && o.requirements === undefined && o.current === version && bundled !== undefined,
        );
    for (const owner of restored) owner.current = bundled;
    if (restored.length > 0) {
      this.log(2, `telo: the telo ${version} engine this workspace last used could not be loaded (${message}); starting on the bundled telo ${bundled}.`);
    }
    const stillNeeded =
      version !== undefined &&
      [...this.documents.keys()].some((key) => {
        const target = this.targetOf(key);
        return "version" in target && target.version === version;
      });
    if (slot.bundled || stillNeeded || restored.length === 0) {
      const kind =
        error instanceof EngineUnavailableError
          ? "offline-uncached"
          : error instanceof EngineIntegrityError || error instanceof EngineRefusedError
            ? "engine-refused"
            : "engine-failed";
      const statusError: StatusError =
        kind === "offline-uncached"
          ? { kind, version: version!, message }
          : { kind, ...(version !== undefined ? { version } : {}), message };
      if (version !== undefined) this.engineErrors.set(version, statusError);
      else this.bundledError = statusError;
      this.log(1, `telo: ${message}`);
    }
    this.forget(slot);
    void this.reconcile();
  }

  /** Stop an engine nothing uses any more. */
  private stop(slot: EngineSlot): void {
    if (slot.ended) return;
    slot.ended = "stopped";
    if (slot.identity !== undefined) this.engines.delete(slot.identity);
    slot.end(new EngineFailedError(`the ${slotName(slot)} engine was stopped: no open document uses it.`));
    void slot.ready.then(
      (connection) => {
        connection.dispose();
        slot.spawned?.terminate();
      },
      () => slot.spawned?.terminate(),
    );
    this.forget(slot);
  }

  /** Everything the editor holds of a gone engine is withdrawn. */
  private forget(slot: EngineSlot): void {
    for (const document of this.documents.values()) {
      if (document.engine !== undefined && document.engine === this.identityOf(slot)) document.engine = undefined;
    }
    slot.diagnostics.clear();
    slot.dynamic.clear();
    slot.watchers.clear();
    if (slot.forwarded.size > 0) {
      const unregisterations = [...slot.forwarded].map(([id, method]) => ({ id, method }));
      slot.forwarded.clear();
      this.client.sendRequest("client/unregisterCapability", { unregisterations }).catch((error) =>
        this.log(1, `telo: could not withdraw the ${slotName(slot)} engine's registrations: ${errorText(error)}`),
      );
    }
    this.syncRegistrations();
    this.refreshDiagnostics();
    this.emitStatus();
  }

  /** The identity a slot runs: a restarted bundled engine is still the one it
   *  last named itself as until its own handshake says otherwise. */
  private identityOf(slot: EngineSlot): string | undefined {
    return slot.identity ?? (slot.bundled ? this.bundledIdentity : undefined);
  }

  /** Engines that answered their handshake and are still running. */
  private running(): EngineSlot[] {
    return [this.bundled, ...this.engines.values()].filter(
      (slot): slot is EngineSlot => slot !== undefined && slot.settled && !slot.ended,
    );
  }

  /** Send a notification to an engine in order. A failure is reported —
   *  except the engine's own failure, which is already the status's error. */
  private notify(slot: EngineSlot, method: string, params?: unknown): void {
    this.enqueue(slot, (c) => c.sendNotification(method, params)).catch((error) => {
      if (slot.ended) return;
      this.log(1, `telo: could not send ${method} to the ${slotName(slot)} engine: ${errorText(error)}`);
    });
  }

  /** Run `send` on an engine after everything queued before it; rejected
   *  (naming the engine and why) if the engine fails first. */
  private enqueue<T>(slot: EngineSlot, send: (connection: MessageConnection) => Promise<T>): Promise<T> {
    const result = slot.queue.then(() => slot.ready).then((c) => Promise.race([send(c), slot.gone]));
    slot.queue = result.catch(() => undefined);
    return result;
  }

  /** The engine's capabilities with its dynamic registrations applied. */
  private capabilitiesOf(slot: EngineSlot): ServerCapabilities {
    const capabilities: Record<string, unknown> = { ...(slot.initializeResult?.capabilities ?? {}) };
    for (const { feature, options } of slot.dynamic.values()) capabilities[feature.capability] = options;
    return capabilities as ServerCapabilities;
  }

  // --- documents -------------------------------------------------------------

  /** Put every open document on the engine it belongs on, then show every
   *  file's diagnostics from the engine that owns it. */
  private async reconcile(): Promise<void> {
    for (const [key, document] of this.documents) {
      const target = this.targetOf(key);
      const version = "version" in target && !this.engineErrors.has(target.version) ? target.version : undefined;
      if (document.engine === version) continue;
      this.closeIn(document);
      if (version !== undefined) this.openIn(document, version);
    }
    this.refreshDiagnostics();
    this.stopIdleEngines();
    this.emitStatus();
  }

  private openIn(document: OpenDocument, version: string): void {
    document.engine = version;
    const slot = this.engine(version);
    this.notify(slot, "textDocument/didOpen", {
      textDocument: { uri: document.uri, languageId: document.languageId, version: document.version, text: document.text },
    });
  }

  private closeIn(document: OpenDocument): void {
    const version = document.engine;
    if (version === undefined) return;
    document.engine = undefined;
    const slot = this.slotOf(version);
    if (slot && !slot.ended) this.notify(slot, "textDocument/didClose", { textDocument: { uri: document.uri } });
  }

  private stopIdleEngines(): void {
    const used = new Set([...this.documents.values()].map((d) => d.engine));
    for (const [version, slot] of [...this.engines]) {
      if (!used.has(version)) this.stop(slot);
    }
  }

  /** What the editor should show for a file: for an open or claimed file, its
   *  serving engine's publication; for any other, the deduplicated union of
   *  what the running engines publish. `undefined` when nothing is known. */
  private diagnosticsFor(key: string): { uri: string; diagnostics: Diagnostic[] } | undefined {
    const document = this.documents.get(key);
    if (document || this.documentOwner.has(key)) {
      let version = document?.engine;
      if (!document) {
        const target = this.targetOf(key);
        version = "version" in target ? target.version : undefined;
      }
      const slot = version === undefined ? undefined : this.slotOf(version);
      const published = slot && !slot.ended ? slot.diagnostics.get(key) : undefined;
      return published && { uri: document?.uri ?? published.uri, diagnostics: published.diagnostics };
    }
    const publications = this.running().flatMap((slot) => slot.diagnostics.get(key) ?? []);
    if (publications.length === 0) return undefined;
    const unique = new Map<string, Diagnostic>();
    for (const p of publications) for (const d of p.diagnostics) unique.set(JSON.stringify(d), d);
    return { uri: publications[0]!.uri, diagnostics: [...unique.values()] };
  }

  private refreshDiagnostics(keys?: Iterable<string>): void {
    const all = keys ? new Set(keys) : new Set([...this.shown.keys(), ...this.documents.keys()]);
    if (!keys) for (const slot of this.running()) for (const key of slot.diagnostics.keys()) all.add(key);
    for (const key of all) {
      const next = this.diagnosticsFor(key);
      const previous = this.shown.get(key);
      // Nothing shown and nothing known yet: the first publication is what the
      // editor sees, not an empty set ahead of it.
      if (!next && !previous) continue;
      const shown = next ?? { uri: previous!.uri, diagnostics: [] };
      const fingerprint = JSON.stringify(shown.diagnostics);
      if (previous?.key === fingerprint) continue;
      if (next) this.shown.set(key, { uri: shown.uri, key: fingerprint });
      else this.shown.delete(key);
      void this.client.sendNotification("textDocument/publishDiagnostics", shown);
    }
  }

  // --- editor registrations ---------------------------------------------------

  /** Re-register with the editor every feature whose union over the running
   *  engines changed — withdrawn when no engine advertises it — and one
   *  registration per distinct file watcher. */
  private syncRegistrations(): void {
    if (!this.clientInitialized) return;
    const running = this.running();
    const unregister: Unregistration[] = [];
    const register: Registration[] = [];
    for (const feature of EDITOR_FEATURES) {
      if (!feature.dynamic(this.clientCapabilities)) continue;
      const options = running.flatMap((slot) => featureOptions(this.capabilitiesOf(slot), feature) ?? []);
      const merged = options.length > 0 ? feature.merge(options) : undefined;
      const key = merged === undefined ? undefined : JSON.stringify(merged);
      const current = this.featureRegistrations.get(feature.registration);
      if (current?.key === key) continue;
      if (current) {
        unregister.push({ id: current.id, method: feature.registration });
        this.featureRegistrations.delete(feature.registration);
      }
      if (merged && key) {
        const id = `telo-${this.nextRegistration++}`;
        this.featureRegistrations.set(feature.registration, { id, key, options: merged });
        register.push({
          id,
          method: feature.registration,
          registerOptions: feature.registration.startsWith("textDocument/") ? { documentSelector: null, ...merged } : merged,
        });
      }
    }
    if (this.clientCapabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration === true) {
      const wanted = new Map<string, FileSystemWatcher>();
      for (const slot of running) {
        for (const list of slot.watchers.values()) for (const w of list) wanted.set(JSON.stringify(w), w);
      }
      for (const [key, id] of [...this.watcherRegistrations]) {
        if (wanted.has(key)) continue;
        unregister.push({ id, method: "workspace/didChangeWatchedFiles" });
        this.watcherRegistrations.delete(key);
      }
      for (const [key, watcher] of wanted) {
        if (this.watcherRegistrations.has(key)) continue;
        const id = `telo-${this.nextRegistration++}`;
        this.watcherRegistrations.set(key, id);
        register.push({ id, method: "workspace/didChangeWatchedFiles", registerOptions: { watchers: [watcher] } });
      }
    }
    if (unregister.length === 0 && register.length === 0) return;
    this.registrationQueue = this.registrationQueue.then(async () => {
      try {
        if (unregister.length > 0) await this.client.sendRequest("client/unregisterCapability", { unregisterations: unregister });
        if (register.length > 0) await this.client.sendRequest("client/registerCapability", { registrations: register });
      } catch (error) {
        this.log(1, `telo: the editor refused a change to the telo features it offers: ${errorText(error)}`);
      }
    });
  }

  /** The semantic-token legend the editor holds: the registered union, or the
   *  bundled engine's when the editor takes only static capabilities. */
  private editorLegend(): SemanticTokensLegend | undefined {
    const registered = this.featureRegistrations.get("textDocument/semanticTokens");
    if (registered) return registered.options.legend as SemanticTokensLegend;
    return (this.bundled?.initializeResult?.capabilities.semanticTokensProvider as { legend?: SemanticTokensLegend } | undefined)
      ?.legend;
  }

  /** The editor's static capabilities: full sync, and for each feature the
   *  editor cannot register dynamically, the bundled engine's options. */
  private initializeResult(): InitializeResult {
    const bundled = this.bundled?.settled && !this.bundled.ended ? this.bundled.initializeResult : undefined;
    const capabilities: Record<string, unknown> = { textDocumentSync: 1 };
    for (const feature of EDITOR_FEATURES) {
      if (feature.dynamic(this.clientCapabilities) || !bundled) continue;
      const options = featureOptions(bundled.capabilities, feature);
      if (options) capabilities[feature.capability] = feature.merge([options]);
    }
    if (bundled?.capabilities.experimental) capabilities.experimental = bundled.capabilities.experimental;
    return {
      capabilities: capabilities as ServerCapabilities,
      serverInfo: bundled?.serverInfo ?? { name: TELO_SERVER_NAME },
    };
  }

  // --- editor → router ---------------------------------------------------------

  private async fromClient(method: string, params: any, token: CancellationToken): Promise<unknown> {
    if (method === "initialize") {
      this.initializeParams = params as InitializeParams;
      this.clientCapabilities = this.initializeParams.capabilities ?? {};
      try {
        this.reading = await readCachedCatalog(this.options.catalogCache);
      } catch (error) {
        this.log(1, `telo: could not read the cached engine catalog: ${errorText(error)}`);
      }
      this.readRegistry();
      this.bundled = this.startBundled();
      await this.bundled.ready.catch(() => undefined);
      this.resolutionsRestored ??= this.restoreResolutions();
      await this.resolutionsRestored;
      return this.initializeResult();
    }
    if (method === "shutdown") {
      await Promise.all(this.running().map((slot) => this.enqueue(slot, (c) => c.sendRequest("shutdown"))));
      return null;
    }
    if (method in RESOLVES) return this.resolve(method, params, token);
    const uri = documentUriOf(method, params);
    if (uri !== undefined) {
      const key = canonicalUri(uri);
      const target = this.targetOf(key);
      const document = this.documents.get(key);
      // A document not open in the editor (a command naming a file) goes to
      // the engine it belongs on.
      const version = document
        ? document.engine
        : "version" in target && !this.engineErrors.has(target.version)
          ? target.version
          : undefined;
      if (version === undefined) {
        throw new ResponseError(
          -32803,
          "error" in target
            ? target.error.message
            : "starting" in target
              ? `the telo engine for ${uri} has not started yet.`
              : (this.engineErrors.get(target.version)?.message ?? `no telo engine serves ${uri}.`),
        );
      }
      const slot = this.engine(version);
      await slot.ready;
      if (advertises(this.capabilitiesOf(slot), method, params) === false) return null;
      return this.answer(slot, method, params, token);
    }
    // A request about no document goes to every running engine serving it;
    // the first answer stands.
    const serving = this.running().filter((slot) => advertises(this.capabilitiesOf(slot), method, params) !== false);
    const answers = await Promise.all(serving.map((slot) => this.answer(slot, method, params, token)));
    return answers[0] ?? null;
  }

  /** An engine's answer, in the editor's terms: semantic tokens in the
   *  editor's legend, and every resolvable item tagged with its producer. */
  private async answer(slot: EngineSlot, method: string, params: unknown, token: CancellationToken): Promise<unknown> {
    const result: any = await this.enqueue(slot, (c) => c.sendRequest(method, params, token));
    if (result && (method === "textDocument/semanticTokens/full" || method === "textDocument/semanticTokens/range")) {
      const legend = featureOptions(this.capabilitiesOf(slot), EDITOR_FEATURES.find((f) => f.registration === "textDocument/semanticTokens")!)
        ?.legend as SemanticTokensLegend | undefined;
      const editor = this.editorLegend();
      if (legend && editor) {
        const remap = legendRemap(legend, editor);
        if (!isIdentityRemap(remap)) return { ...result, data: remapTokens(result.data, remap) };
      }
      return result;
    }
    const resolve = Object.entries(RESOLVES).find(([, produced]) => produced === method)?.[0];
    if (resolve && result && advertises(this.capabilitiesOf(slot), resolve, {})) {
      const items: any[] = Array.isArray(result) ? result : Array.isArray(result.items) ? result.items : [];
      for (const item of items) {
        if (item && typeof item === "object" && !("command" in item && typeof item.command === "string")) {
          item.data = { [PRODUCER]: slot.identity, data: item.data };
        }
      }
    }
    return result;
  }

  /** A resolve goes back to the engine that produced the item; an item whose
   *  producer no longer runs is answered as it came. */
  private async resolve(method: string, params: any, token: CancellationToken): Promise<unknown> {
    const tag = params?.data?.[PRODUCER];
    const slot = typeof tag === "string" ? this.slotOf(tag) : undefined;
    if (!slot || slot.ended) return params;
    const item = { ...params, data: params.data.data };
    const resolved: any = await this.enqueue(slot, (c) => c.sendRequest(method, item, token));
    return resolved && typeof resolved === "object" ? { ...resolved, data: { [PRODUCER]: tag, data: resolved.data } } : resolved;
  }

  private async clientNotification(method: string, params: any): Promise<void> {
    if (method === "exit") {
      for (const slot of this.running()) {
        slot.ready.then(
          (c) => c.sendNotification("exit").finally(() => slot.spawned?.terminate()),
          () => slot.spawned?.terminate(),
        );
      }
      return;
    }
    if (method === "initialized") {
      this.clientInitialized = true;
      this.syncRegistrations();
      return;
    }
    if (TEXT_DOCUMENT_SYNC.has(method)) {
      await this.syncDocument(method, params);
      return;
    }
    if (method === "workspace/didChangeWatchedFiles") {
      // Each engine hears once about each change its own watchers match.
      const changes: FileEvent[] = params?.changes ?? [];
      for (const slot of this.running()) {
        const watchers = [...slot.watchers.values()].flat();
        const matching = changes.filter((change) => watchers.some((w) => watcherMatches(w, change)));
        if (matching.length > 0) this.notify(slot, method, { changes: matching });
      }
      return;
    }
    for (const slot of this.running()) this.notify(slot, method, params);
  }

  private async syncDocument(method: string, params: any): Promise<void> {
    const uri: string = params.textDocument.uri;
    const key = canonicalUri(uri);
    if (method === "textDocument/didOpen") {
      const { languageId, version, text } = params.textDocument;
      this.documents.set(key, { uri, languageId, version, text });
      await this.reconcile();
      return;
    }
    const document = this.documents.get(key);
    if (!document) return;
    if (method === "textDocument/didClose") {
      this.closeIn(document);
      this.documents.delete(key);
      this.refreshDiagnostics();
      this.stopIdleEngines();
      return;
    }
    const changes = params.contentChanges as Array<{ text: string; range?: unknown }>;
    const whole = changes.filter((c) => c.range === undefined).pop();
    if (whole) document.text = whole.text;
    document.version = params.textDocument.version;
    if (document.engine !== undefined) this.notify(this.engine(document.engine), method, params);
  }

  // --- engine → router ---------------------------------------------------------

  private async fromEngine(slot: EngineSlot, method: string, params: any, token: CancellationToken): Promise<unknown> {
    if (method in TELO_REQUESTS) {
      const serve = this.services[method as keyof TeloHostRequests] as (p: unknown) => Promise<unknown>;
      return serve(params);
    }
    if (method === "client/registerCapability") return this.engineRegisters(slot, params.registrations ?? []);
    if (method === "client/unregisterCapability") return this.engineUnregisters(slot, params.unregisterations ?? []);
    return this.client.sendRequest(method, params, token);
  }

  /** An engine's dynamic registrations: file watchers and the features the
   *  router owns join the editor's registrations; anything else is passed on. */
  private async engineRegisters(slot: EngineSlot, registrations: Registration[]): Promise<null> {
    const passed: Registration[] = [];
    for (const r of registrations) {
      const feature = EDITOR_FEATURES.find((f) => f.registration === r.method);
      if (r.method === "workspace/didChangeWatchedFiles") {
        slot.watchers.set(r.id, (r.registerOptions as { watchers?: FileSystemWatcher[] } | undefined)?.watchers ?? []);
      } else if (feature) {
        slot.dynamic.set(r.id, { feature, options: (r.registerOptions as FeatureOptions | undefined) ?? {} });
      } else passed.push(r);
    }
    if (passed.length > 0) {
      await this.client.sendRequest("client/registerCapability", { registrations: passed });
      for (const r of passed) slot.forwarded.set(r.id, r.method);
    }
    this.syncRegistrations();
    return null;
  }

  private async engineUnregisters(slot: EngineSlot, unregisterations: Unregistration[]): Promise<null> {
    const passed = unregisterations.filter((u) => slot.forwarded.has(u.id));
    for (const u of unregisterations) {
      slot.watchers.delete(u.id);
      slot.dynamic.delete(u.id);
      slot.forwarded.delete(u.id);
    }
    if (passed.length > 0) await this.client.sendRequest("client/unregisterCapability", { unregisterations: passed });
    this.syncRegistrations();
    return null;
  }

  private engineNotification(slot: EngineSlot, method: string, params: any): void {
    if (slot.ended) return;
    if (method === "textDocument/publishDiagnostics") {
      const key = canonicalUri(params.uri);
      slot.diagnostics.set(key, { uri: params.uri, diagnostics: params.diagnostics });
      this.refreshDiagnostics([key]);
      return;
    }
    if (method === TeloMethod.requirements) {
      void this.requirements(slot, canonicalRequirements(params as RequirementsParams));
      return;
    }
    void this.client.sendNotification(method, params);
  }

  private async requirements(slot: EngineSlot, params: RequirementsParams): Promise<void> {
    const state: OwnerState = this.owners.get(params.owner) ?? { documents: [], movedFor: new Set<string>() };
    this.owners.set(params.owner, state);
    // Only the engine serving the owner speaks for it; a late message from an
    // engine it has left is stale.
    if (state.current !== undefined && state.current !== slot.identity) return;
    state.current ??= slot.identity;
    const before = JSON.stringify([state.current, state.documents]);
    state.requirements = params;
    state.restored = false;
    // A file the owner no longer claims is no longer its member: it falls
    // under the rule for files no open module claims.
    for (const document of state.documents) {
      if (!params.documents.includes(document) && this.documentOwner.get(document) === params.owner) {
        this.documentOwner.delete(document);
      }
    }
    state.documents = params.documents;
    for (const document of params.documents) this.documentOwner.set(document, params.owner);
    this.select(state);
    if (JSON.stringify([state.current, state.documents]) !== before) this.persistResolutions();
    await this.reconcile();
  }

  // --- status ----------------------------------------------------------------

  private emitStatus(): void {
    const status = this.status();
    for (const listener of this.statusListeners) listener(status);
  }

  private log(type: 1 | 2, message: string): void {
    void this.client.sendNotification("window/logMessage", { type, message });
  }
}

const TELO_REQUESTS: Record<keyof TeloHostRequests, true> = {
  "telo/read": true,
  "telo/exists": true,
  "telo/listDirectory": true,
  "telo/hub/searchRefs": true,
  "telo/hub/listVersions": true,
};

/** `telo/requirements` with every URI in canonical form — the router's keys. */
function canonicalRequirements(params: RequirementsParams): RequirementsParams {
  return {
    owner: canonicalUri(params.owner),
    documents: params.documents.map(canonicalUri),
    ranges: params.ranges.map((r) => ({ ...r, module: canonicalUri(r.module) })),
  };
}

/** The document a request is about: its `textDocument`, or the `uri` a telo
 *  command names as its first argument. */
function documentUriOf(method: string, params: any): string | undefined {
  if (typeof params?.textDocument?.uri === "string") return params.textDocument.uri;
  if (method === "workspace/executeCommand" && typeof params?.arguments?.[0]?.uri === "string") {
    return params.arguments[0].uri;
  }
  return undefined;
}

function slotName(slot: EngineSlot): string {
  if (slot.identity === undefined) return "bundled telo";
  return `${slot.bundled ? "bundled " : ""}telo ${slot.identity}`;
}

function describeUnoffered(reason: UnofferedReason | "unpublished"): string {
  switch (reason) {
    case "unpublished":
      return "no such version of @telorun/language-server is published";
    case "below-protocol-floor":
      return "it predates the editor protocol (its engine declares no teloEditorProtocol)";
    case "unspoken-generation":
      return "its engine speaks an editor protocol generation this editor does not";
    case "prerelease":
      return "it is a prerelease";
    case "deprecated":
      return "it is deprecated";
    case "unverifiable":
      return "its published package carries no sha512 integrity to verify it against";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
