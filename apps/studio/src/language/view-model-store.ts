import type { ViewModel, ViewModelChangedParams } from "@telorun/editor-protocol";
import { describeTeloStatus, type TeloStatus } from "@telorun/language-host";
import { STUDIO_TELO_STATUS_HOST } from "./telo-status-host";

/** What the structured views of one module can read. */
export type ViewModelStatus =
  /** Asked for, or waiting for an engine to serve the module. */
  | { state: "loading" }
  | { state: "ready"; model: ViewModel }
  /** The engine serving the module predates structured editing. */
  | { state: "unsupported"; version?: string }
  /** The engine is not analysing the module. */
  | { state: "absent" }
  /** The request for the model failed, or the engine the module is edited
   *  against cannot run; `error` is why. */
  | { state: "failed"; error: string };

/** The slice of a language session the store reads. */
export interface ViewModelSource {
  ownerOf(modulePath: string): string;
  supportsViewModel(modulePath: string): boolean | undefined;
  viewModel(modulePath: string, configuration?: Record<string, unknown>): Promise<ViewModel | null>;
  statusOf(modulePath: string): TeloStatus;
  /** Start the engines that failed again. */
  retry(): Promise<void>;
  /** The version of the open document at canonical `uri` last sent to the
   *  engines; undefined when it is not open. */
  documentVersion(uri: string): number | undefined;
  onViewModelChanged(listener: (params: ViewModelChangedParams) => void): { dispose(): void };
  onStatus(listener: (status: TeloStatus) => void): { dispose(): void };
}

interface Entry {
  modulePath: string;
  status: ViewModelStatus;
  listeners: Set<() => void>;
  /** The status needs evaluating again: an announced revision above the held
   *  one, no engine serving the module yet, or a failed read. */
  stale: boolean;
  /** No running engine serves the module: its status follows the session's. */
  unserved: boolean;
  fetching: boolean;
  /** Another fetch was asked for while one was under way. */
  again: boolean;
  /** The configuration the reader picked; absent until it picks one. */
  configuration?: Record<string, unknown>;
  /** The configuration the held model was asked for, as text. */
  heldFor?: string;
}

const LOADING: ViewModelStatus = { state: "loading" };

/**
 * The last view model of each module a structured view reads, per workspace.
 *
 * A module is fetched when its first reader subscribes and again whenever its
 * engine announces a revision above the one held; fetches of one module never
 * overlap — one asked for meanwhile runs once the current one settles — and an
 * answer at or below the held revision is dropped. A module nobody reads is not
 * fetched: it is marked stale and fetched on its next subscription.
 */
export class ViewModelStore {
  private readonly entries = new Map<string, Entry>();
  private readonly subscriptions: Array<{ dispose(): void }>;

  constructor(private readonly source: ViewModelSource) {
    this.subscriptions = [
      source.onViewModelChanged((params) => this.changed(params)),
      // The serving engine starting or failing changes what an unserved
      // module's status is, with no announcement for a module the router has
      // not yet seen analysed.
      source.onStatus(() => {
        for (const entry of this.entries.values()) {
          if (entry.listeners.size > 0 && entry.unserved) this.evaluate(entry);
        }
      }),
    ];
  }

  /** What the module's structured views can read now. */
  get(modulePath: string): ViewModelStatus {
    return this.entries.get(this.source.ownerOf(modulePath))?.status ?? LOADING;
  }

  /** Read the module: `listener` is called whenever its status changes. */
  subscribe(modulePath: string, listener: () => void): { dispose(): void } {
    const owner = this.source.ownerOf(modulePath);
    let entry = this.entries.get(owner);
    if (!entry) {
      entry = {
        modulePath,
        status: LOADING,
        listeners: new Set(),
        stale: true,
        unserved: false,
        fetching: false,
        again: false,
      };
      this.entries.set(owner, entry);
    }
    const subscribed = entry;
    subscribed.listeners.add(listener);
    if (subscribed.listeners.size === 1 && subscribed.stale) this.evaluate(subscribed);
    return { dispose: () => void subscribed.listeners.delete(listener) };
  }

  /** Read a failed module again, for as long as it has a reader — starting
   *  its engine again first when the engine is what failed. */
  retry(modulePath: string): void {
    const entry = this.entries.get(this.source.ownerOf(modulePath));
    if (!entry || entry.status.state !== "failed" || entry.listeners.size === 0) return;
    if (!entry.unserved) return this.evaluate(entry);
    this.set(entry, LOADING);
    this.source.retry().then(
      () => this.evaluate(entry),
      (error: unknown) =>
        this.set(entry, {
          state: "failed",
          error: `the telo engine could not be started again: ${error instanceof Error ? error.message : String(error)}`,
        }),
    );
  }

  /** Whether `model` was computed from the text the editor holds now: every
   *  open document it was analysed from, the owner's own among them, is still
   *  at the version it read. A stale model's paths may name what an edit has
   *  since moved. */
  isCurrent(model: ViewModel): boolean {
    if (model.documents[model.owner] === undefined) return false;
    return Object.entries(model.documents).every(([uri, version]) => this.source.documentVersion(uri) === version);
  }

  /** Draw the module's choices in `configuration`: the model is read again,
   *  and an answer for it replaces the held one at the same revision. */
  configure(modulePath: string, configuration: Record<string, unknown>): void {
    const entry = this.entries.get(this.source.ownerOf(modulePath));
    if (!entry) return;
    entry.configuration = configuration;
    entry.stale = true;
    if (entry.listeners.size > 0) this.evaluate(entry);
  }

  /** Read the module again now, for as long as it has a reader — when what it
   *  holds is known to be behind the editor. */
  refresh(modulePath: string): void {
    const entry = this.entries.get(this.source.ownerOf(modulePath));
    if (!entry || entry.listeners.size === 0) return;
    entry.stale = true;
    this.evaluate(entry);
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const entry of this.entries.values()) entry.listeners.clear();
    this.entries.clear();
  }

  private changed({ owner, revision }: ViewModelChangedParams): void {
    const entry = this.entries.get(owner);
    if (!entry) return;
    if (entry.status.state === "ready" && revision <= entry.status.model.revision) return;
    entry.stale = true;
    if (entry.listeners.size > 0) this.evaluate(entry);
  }

  private evaluate(entry: Entry): void {
    if (entry.fetching) {
      entry.again = true;
      return;
    }
    const supported = this.source.supportsViewModel(entry.modulePath);
    // Unserved, the module is evaluated again when the session's status moves:
    // an engine coming to serve it, or the one it needs failing.
    entry.unserved = supported === undefined;
    entry.stale = entry.unserved;
    if (supported === undefined) {
      const status = this.source.statusOf(entry.modulePath);
      if (!status.error) return this.set(entry, LOADING);
      const error = describeTeloStatus(status, STUDIO_TELO_STATUS_HOST).detail;
      if (entry.status.state === "failed" && entry.status.error === error) return;
      return this.set(entry, { state: "failed", error });
    }
    if (!supported) {
      const version = this.source.statusOf(entry.modulePath).version;
      return this.set(entry, { state: "unsupported", ...(version !== undefined ? { version } : {}) });
    }
    if (entry.status.state !== "ready") this.set(entry, LOADING);
    entry.fetching = true;
    const asked = JSON.stringify(entry.configuration ?? null);
    this.source.viewModel(entry.modulePath, entry.configuration).then(
      (model) => this.settle(entry, model ? { state: "ready", model } : { state: "absent" }, asked),
      (error: unknown) =>
        this.settle(
          entry,
          {
            state: "failed",
            error: `the view model of ${entry.modulePath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
          },
          asked,
        ),
    );
  }

  private settle(entry: Entry, status: ViewModelStatus, asked: string): void {
    entry.fetching = false;
    if (this.entries.get(this.source.ownerOf(entry.modulePath)) !== entry) return;
    const held = entry.status.state === "ready" ? entry.status.model.revision : undefined;
    // An answer for another configuration is not behind the held one, whatever
    // its revision.
    const dropped =
      status.state === "ready" && held !== undefined && status.model.revision <= held && entry.heldFor === asked;
    if (!dropped) {
      this.set(entry, status);
      if (status.state === "ready") entry.heldFor = asked;
    }
    // A failed read is tried again by the next reader or announcement.
    if (status.state === "failed") entry.stale = true;
    if (entry.again) {
      entry.again = false;
      if (entry.listeners.size > 0) this.evaluate(entry);
      else entry.stale = true;
    }
  }

  private set(entry: Entry, status: ViewModelStatus): void {
    if (entry.status === status) return;
    entry.status = status;
    for (const listener of [...entry.listeners]) listener();
  }
}
