import { sessionWorkspace } from "../agent/agent-workspace";
import { seedDelta } from "../agent/sync";
import type { AgentWorkspace, WorkspaceBridge } from "../agent/types";
import type { ResumeSecretStore, RunnerCredentials } from "./runner-credentials";
import { runnerIdentityEligibility } from "./runner-identity";
import { appSetStep, sameAppSet } from "./session-apps";
import { resolveSession } from "./session-resolution";
import {
  RunnerRefusal,
  SessionGoneError,
  TeloVersionRefusedError,
  TermsRequiredError,
  type IoMode,
  type RunAdapter,
  type RunAppRequest,
  type RunEvent,
  type RunnerCapabilities,
  type RunnerEndpoint,
  type RunnerSession,
  type RunnerTerms,
  type RunStatus,
  type SequencedRunIo,
  type SessionAppSpec,
} from "./types";
import type { WorkspaceSessionEntry } from "./workspace-session-entry";

/** The runner catalog name of the authoring agent, asked for as a session's
 *  co-resident agent in Agent mode. */
export const AGENT_APP_NAME = "authoring-agent";

/** One app's slot in the session, as its `app` events last said. */
export interface AppSlot {
  state: "pending" | "ready" | "running";
  runId?: string;
}

/** Why a Run waits instead of starting, in words the dock shows. */
export type RunWait =
  | "session" // the session is not up yet
  | "app-set" // the app is not in the session's applied set yet
  | "turn" // the set waits for the agent's turn to end
  | "app"; // the app's container is not ready yet

export interface WorkspaceSessionState {
  /** What the runner said of itself, once asked; null for a runner too old
   *  to say. */
  capabilities: RunnerCapabilities | null;
  /** Whether the runner offers the agent as a co-resident one; null until
   *  known. */
  agentOffered: boolean | null;
  /** `connecting` while the session is found or created; `terms` while the
   *  runner's agreement waits to be accepted; `live` once there is a session;
   *  `failed` when none could be had, with `problem` saying why. */
  phase: "connecting" | "terms" | "live" | "failed";
  problem: string | null;
  terms: RunnerTerms | null;
  sessionId: string | null;
  /** The session's own status, from its event stream. */
  status: RunStatus | null;
  /** The last session-wide progress message while it comes up. */
  progress: string | null;
  /** Why the workspace's files could not be pushed into the session; set until
   *  the next write or a retry, which is the only thing that tries again. */
  syncProblem: string | null;
  /** The app set the session holds, by name. */
  applied: ReadonlySet<string>;
  /** Whether the desired set differs from the applied one, and why it is not
   *  applied yet. */
  appSet: { pending: "none" | "turn" | "session" | "applying"; problem: string | null };
  slots: ReadonlyMap<string, AppSlot>;
  /** Apps with a Run waiting, and what each waits for. */
  waiting: ReadonlyMap<string, RunWait>;
  /** Where the co-resident agent answers, once the session reports it. */
  agent: RunnerEndpoint | null;
  /** Why a running session in Agent mode has no agent to reach — its change
   *  was refused, or the runner reports no address for it; null otherwise. */
  agentUnavailable: string | null;
  inspectUrl: string | null;
  endpoints: RunnerEndpoint[];
  /** What the session is reached with, once found: the signed-in identity,
   *  or a resume secret — with why, when a signed-in user's identity is not
   *  used on this runner. */
  credential: { kind: "identity" } | { kind: "secret"; reason: string | null } | null;
}

/** The signed-in identity, as a session can use it on a runner that accepts
 *  it. */
export interface WorkspaceIdentity {
  /** Studio's own identity provider. */
  issuer: string;
  /** Credentials for the runner whose audience is `resource`. */
  credentials(resource: string): RunnerCredentials;
}

export interface WorkspaceSessionOptions {
  workspaceKey: string;
  entry: WorkspaceSessionEntry;
  runner: { id: string; adapter: RunAdapter<unknown>; config: unknown };
  /** Agent mode asks for the co-resident agent; Manual for none. */
  mode: "agent" | "manual";
  /** Whether the user accepted these terms on this runner. */
  termsAccepted(terms: RunnerTerms): boolean;
  secrets: ResumeSecretStore;
  /** The signed-in identity; null when signed out. */
  identity: WorkspaceIdentity | null;
  /** Persist the workspace's entry after the session it names changed. */
  saveEntry(entry: WorkspaceSessionEntry): void;
  /** The editor's side of the workspace, which seeds the session. */
  bridge: WorkspaceBridge;
  listener: {
    changed(): void;
    event(event: RunEvent): void;
    /** An app that was running when the pod was recreated is ready again. */
    rerun(app: string): void;
    /** A seed or save could not reach the session. */
    syncFailed(message: string): void;
  };
}

interface QueuedRun {
  request: RunAppRequest;
  resolve(runId: string): void;
  reject(err: Error): void;
}

/** The delays before a set or agent change the runner answered
 *  `session_busy` is sent again; the last repeats. */
const BUSY_RETRY_MS = [250, 500, 1000, 2000, 5000];

/** Thrown to a queued Run that was withdrawn before it started. */
export class RunWithdrawnError extends Error {
  constructor() {
    super("The run was withdrawn before it started.");
    this.name = "RunWithdrawnError";
  }
}

function teloRefusal(err: TeloVersionRefusedError): string {
  const subject = err.version ? `Telo ${err.version}` : "This telo version";
  return `${err.app ? `'${err.app}': ` : ""}${subject} cannot be run here: ${err.reason}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A workspace's runner session, held for as long as the workspace is open in
 * Agent or Manual mode: found or created when it opens, resumed when it was
 * suspended, seeded from the editor, kept to the workspace's app set, and
 * suspended when the workspace closes.
 */
export class WorkspaceSession {
  private readonly options: WorkspaceSessionOptions;
  private entry: WorkspaceSessionEntry;
  private session: RunnerSession | null = null;
  private workspaceSurface: AgentWorkspace | null = null;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  private phase: WorkspaceSessionState["phase"] = "connecting";
  private problem: string | null = null;
  private terms: RunnerTerms | null = null;
  private status: RunStatus | null = null;
  private progress: string | null = null;
  private credential: WorkspaceSessionState["credential"] = null;

  private applied: SessionAppSpec[] = [];
  private desired: SessionAppSpec[] | null = null;
  private desiredSettled = false;
  /** Whether the desired set names telo versions; it is sent only when that
   *  matches what the runner said of itself. */
  private desiredVersioned = false;
  /** Woken whenever the desired set changes, which a create waits on. */
  private desiredWaiters: Array<() => void> = [];
  private turnActive = false;
  private applying = false;
  private setProblem: string | null = null;
  /** The last set the runner refused, not sent again until the set changes. */
  private refusedSet: SessionAppSpec[] | null = null;
  private capabilities: RunnerCapabilities | null = null;
  private capabilitiesRead = false;
  private mode: "agent" | "manual";
  private acceptedTerms: string | undefined;
  private agentApplied: string | null = null;
  private agentWanted: string | null = null;
  /** Why the agent this mode wants could not be applied. */
  private agentProblem: string | null = null;
  /** An agent change was accepted and the status it brings is still to come. */
  private agentAwaitingStatus = false;
  /** A `session_busy` answer holds set and agent changes until this fires. */
  private busyTimer: ReturnType<typeof setTimeout> | null = null;
  private busyAttempts = 0;

  private readonly slots = new Map<string, AppSlot>();
  private readonly queued = new Map<string, QueuedRun>();
  /** Apps whose run a recreation ended, to start again once they are ready. */
  private readonly rerun = new Set<string>();

  private seeded = false;
  private seeding: Promise<void> | null = null;
  private syncAgain = false;
  private seedFailure: string | null = null;
  private snapshot: WorkspaceSessionState;

  constructor(options: WorkspaceSessionOptions) {
    this.options = options;
    this.entry = options.entry;
    this.mode = options.mode;
    this.snapshot = this.compose();
  }

  get state(): WorkspaceSessionState {
    return this.snapshot;
  }

  /** The session's workspace surface while it is running: the co-resident
   *  agent reads and writes the same files through it. */
  get workspace(): AgentWorkspace | null {
    return this.status?.kind === "running" ? this.workspaceSurface : null;
  }

  /** Accept the runner's terms the session waits on, and carry on opening. */
  acceptTerms(version: string): void {
    this.acceptedTerms = version;
    void this.open();
  }

  /** Find or create the session: connect, ask the runner what it offers, wait
   *  for its terms when they are not accepted yet, then resolve the session. */
  async open(): Promise<void> {
    if (this.disposed) return;
    this.seedFailure = null;
    this.phase = "connecting";
    this.problem = null;
    this.terms = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.changed();
    try {
      const adapter = this.options.runner.adapter;
      // Connected first: a local runner is started here, and answers nothing
      // about itself until it is up.
      const connection = await adapter.connect(this.options.runner.config);
      if (this.disposed) return;
      if (!this.capabilitiesRead) {
        this.capabilities = (await adapter.fetchCapabilities?.(this.options.runner.config)) ?? null;
        this.capabilitiesRead = true;
        if (this.disposed) return;
        this.changed();
      }
      this.agentWanted = this.agentFor(this.mode);
      this.agentProblem = null;
      const terms = this.capabilities?.terms;
      if (terms && this.acceptedTerms !== terms.version) {
        if (this.options.termsAccepted(terms)) {
          this.acceptedTerms = terms.version;
        } else {
          this.phase = "terms";
          this.terms = terms;
          this.changed();
          return;
        }
      }
      const acceptedTermsVersion = this.acceptedTerms;
      // A pod is created for the app set, so the set is known first — with
      // telo versions exactly when this runner takes them: every later change
      // to it recreates the pod.
      while (!this.desiredReady()) {
        await new Promise<void>((resolve) => this.desiredWaiters.push(resolve));
        if (this.disposed) return;
      }
      const identity = this.options.identity;
      const eligibility = runnerIdentityEligibility({
        signedIn: identity !== null,
        connectedBaseUrl: connection.baseUrl,
        identity: this.capabilities?.identity,
        issuer: identity?.issuer ?? "",
      });
      this.credential = eligibility.use ? { kind: "identity" } : { kind: "secret", reason: eligibility.reason };
      const sameRunner = this.entry.runner === this.options.runner.id;
      const resolved = await resolveSession({
        resume: this.entry.resume !== "manual",
        connection,
        stored:
          sameRunner && this.entry.sessionId
            ? { sessionId: this.entry.sessionId, resumeSecret: await this.options.secrets.read(this.secretScope) }
            : null,
        identity: eligibility.use && identity ? identity.credentials(eligibility.resource) : null,
        create: {
          workspace: this.entry.workspace,
          apps: this.desired ?? [],
          ...(this.agentWanted ? { agent: this.agentWanted } : {}),
        },
        createOptions: {
          ...(acceptedTermsVersion ? { acceptedTermsVersion } : {}),
          withheldConfig: this.withheldConfig(),
        },
      });
      if (this.disposed) {
        if (resolved.created) await this.keep(resolved.session.id, resolved.owner, resolved.resumeSecret);
        return;
      }
      await this.keep(resolved.session.id, resolved.owner, resolved.resumeSecret);
      this.session = resolved.session;
      this.workspaceSurface = sessionWorkspace(resolved.session);
      this.status = resolved.document.status;
      this.applied = resolved.document.apps.map((app) => ({
        name: app.name,
        entryRelativePath: app.entryRelativePath,
        ports: app.ports,
        ...(app.telo !== undefined ? { telo: app.telo } : {}),
      }));
      this.agentApplied = resolved.document.agent;
      this.slots.clear();
      for (const app of resolved.document.apps) {
        this.slots.set(app.name, { state: app.state, ...(app.runId ? { runId: app.runId } : {}) });
      }
      this.phase = "live";
      this.subscribe();
      this.changed();
      this.advance();
    } catch (err) {
      if (this.disposed) return;
      if (err instanceof TermsRequiredError) {
        this.phase = "terms";
        this.terms = err.terms;
      } else {
        this.phase = "failed";
        this.problem = err instanceof TeloVersionRefusedError ? teloRefusal(err) : message(err);
      }
      this.changed();
    }
  }

  /** The app set the workspace has now; `settled` is false while a version is
   *  still being found, `versioned` whether its apps name telo versions. */
  setDesired(apps: SessionAppSpec[], settled: boolean, versioned: boolean): void {
    this.desired = apps;
    this.desiredSettled = settled;
    this.desiredVersioned = versioned;
    const waiters = this.desiredWaiters;
    this.desiredWaiters = [];
    for (const wake of waiters) wake();
    this.changed();
    this.advance();
  }

  /** Whether an agent turn is running: a set change waits for it to end. */
  setTurnActive(active: boolean): void {
    if (this.turnActive === active) return;
    this.turnActive = active;
    this.changed();
    this.advance();
  }

  /** Switch between Agent and Manual: the pod is recreated with or without
   *  the agent. */
  setMode(mode: "agent" | "manual"): void {
    this.mode = mode;
    if (!this.capabilitiesRead) return;
    this.agentWanted = this.agentFor(mode);
    this.agentProblem = null;
    this.changed();
    this.advance();
  }

  /** One app's byte channel, from the output after `fromSeq`. */
  io(app: string, fromSeq: number): SequencedRunIo {
    return this.liveSession().io(app, fromSeq);
  }

  /** The byte-channel mode a Run asks for: a terminal where the runner offers
   *  one, its separate streams otherwise. */
  get runIo(): IoMode {
    const offered = this.capabilities?.features.io ?? [];
    return offered.includes("tty") || offered.length === 0 ? "tty" : offered[0]!;
  }

  /** Start an app's run, once the session can: it waits for the session, the
   *  app's place in the applied set and its container. */
  run(app: string, request: RunAppRequest): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.queued.get(app)?.reject(new RunWithdrawnError());
      this.queued.set(app, { request, resolve, reject });
      this.changed();
      this.advance();
    });
  }

  /** Withdraw a Run still waiting; true when there was one. */
  withdraw(app: string): boolean {
    const waiting = this.queued.get(app);
    if (!waiting) return false;
    this.queued.delete(app);
    this.rerun.delete(app);
    waiting.reject(new RunWithdrawnError());
    this.changed();
    return true;
  }

  async stop(app: string): Promise<void> {
    this.withdraw(app);
    const session = this.liveSession();
    await session.stopApp(app);
  }

  async reload(app: string): Promise<void> {
    await this.liveSession().reload(app);
  }

  /** Push the editor's files into the session after a write. Coalesced: a
   *  write during a sync is carried by one more pass. Skipped during an agent
   *  turn, when the agent owns the files — the editor only takes its writes
   *  then, and its end-of-turn reconcile converges the two. */
  sync(): void {
    if (this.turnActive || this.status?.kind !== "running" || this.disposed) return;
    this.seedFailure = null;
    if (this.seeding) {
      this.syncAgain = true;
      return;
    }
    this.seed();
  }

  /** Whether a sync is in flight. */
  get syncing(): boolean {
    return this.seeding !== null;
  }

  /** Suspend the session and let go of it: the workspace closed, or moved to
   *  Only on this device. */
  async suspend(): Promise<void> {
    const session = this.session;
    // A session still starting is up on the runner too: switching it off must
    // suspend it, or it stays up after the workspace has let go of it.
    const live = this.status?.kind === "running" || this.status?.kind === "starting";
    this.dispose();
    if (!session || !live) return;
    await session.suspend();
  }

  /** Let go of the session without telling the runner anything. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.busyTimer) clearTimeout(this.busyTimer);
    this.busyTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const waiting of this.queued.values()) waiting.reject(new RunWithdrawnError());
    this.queued.clear();
  }

  // ---- internals -----------------------------------------------------------

  private get secretScope() {
    return { runner: this.options.runner.id, workspaceKey: this.options.workspaceKey };
  }

  /** Remember the session this workspace holds on this runner and who owns
   *  it, or — with null — that it holds none, so the next open creates one. A
   *  secret that cannot be stored is reported: the session works, but the
   *  next open cannot reach it. */
  private async keep(sessionId: string | null, owner: "identity" | "secret", resumeSecret: string | null): Promise<void> {
    const next: WorkspaceSessionEntry = { ...this.entry, runner: this.options.runner.id };
    delete next.resumeSecret;
    delete next.owner;
    if (sessionId === null) delete next.sessionId;
    else {
      next.sessionId = sessionId;
      if (owner === "identity") next.owner = "identity";
    }
    this.entry = next;
    this.options.saveEntry(next);
    try {
      await this.options.secrets.write(this.secretScope, resumeSecret);
    } catch (err) {
      this.options.listener.syncFailed(
        `This workspace's resume secret could not be kept, so reopening it creates a new session: ${message(err)}`,
      );
    }
  }

  /** Follow the session's event stream; opened again after a failed session
   *  is resumed, since a failure ends it. */
  private subscribe(): void {
    const session = this.session;
    if (!session || this.unsubscribe) return;
    this.unsubscribe = session.subscribe(
      (event) => this.onEvent(event),
      (reason) => this.onStreamClosed(reason),
    );
  }

  private agentFor(mode: "agent" | "manual"): string | null {
    return mode === "agent" && this.capabilities?.features.agents?.includes(AGENT_APP_NAME) ? AGENT_APP_NAME : null;
  }

  /** Whether the desired set may be sent: settled, and naming telo versions
   *  exactly when the runner said it takes them. */
  private desiredReady(): boolean {
    return (
      this.desired !== null &&
      this.desiredSettled &&
      this.desiredVersioned === (this.capabilities?.features.teloVersions === true)
    );
  }

  /** Hold set and agent changes after a `session_busy`, with a growing delay;
   *  a status event takes the next step sooner. */
  private holdWhileBusy(): void {
    const delay = BUSY_RETRY_MS[Math.min(this.busyAttempts, BUSY_RETRY_MS.length - 1)]!;
    this.busyAttempts++;
    this.busyTimer = setTimeout(() => {
      this.busyTimer = null;
      this.advance();
    }, delay);
  }

  private releaseBusyHold(): void {
    if (!this.busyTimer) return;
    clearTimeout(this.busyTimer);
    this.busyTimer = null;
  }

  private withheldConfig(): string[] {
    const versioned = this.capabilities?.features.teloVersions === true;
    return versioned ? (this.capabilities?.config.supersededByTelo ?? []) : [];
  }

  private liveSession(): RunnerSession {
    if (!this.session) throw new Error("The workspace has no runner session yet.");
    return this.session;
  }

  private onEvent(event: RunEvent): void {
    if (this.disposed) return;
    if (event.type === "status" && event.status.kind === "stopped") {
      // Deleted on the runner: nothing of it is left to resume, so the next
      // open creates a new session and seeds it.
      this.status = event.status;
      void this.keep(null, "secret", null);
      this.phase = "failed";
      this.problem = "The runner deleted this workspace's session; a new one is created when you try again.";
      this.failQueued(new Error(this.problem));
      this.options.listener.event(event);
      this.changed();
      return;
    }
    if (event.type === "status") {
      this.agentAwaitingStatus = false;
      this.releaseBusyHold();
      // The stream ends itself on a failure. That failure may be one the
      // replay of a resumed session carries, so the session is read again: one
      // that is up again is followed on, and one still failed resumes on Run.
      if (event.status.kind === "failed") {
        this.unsubscribe = null;
        void this.recheck();
      }
      const wasRunning = this.status?.kind === "running";
      this.status = event.status;
      if (event.status.kind !== "starting") this.progress = null;
      if (event.status.kind === "running" && !wasRunning) this.seeded = false;
      if (event.status.kind !== "running") {
        for (const slot of this.slots.values()) {
          slot.state = "pending";
          delete slot.runId;
        }
      }
    } else if (event.type === "progress" && event.app === undefined) {
      if (this.status?.kind === "starting") this.progress = event.message;
    } else if (event.type === "app") {
      const slot: AppSlot =
        event.state === "running" ? { state: "running", runId: event.runId } : { state: "ready" };
      this.slots.set(event.app, slot);
      if (event.state === "ready" && !event.ended && this.rerun.delete(event.app)) {
        this.options.listener.rerun(event.app);
      }
    }
    this.options.listener.event(event);
    this.changed();
    this.advance();
  }

  private onStreamClosed(reason: string): void {
    if (this.disposed) return;
    this.unsubscribe = null;
    this.phase = "failed";
    this.problem = reason;
    this.failQueued(new Error(reason));
    this.changed();
  }

  /** Take every step the session's state allows now. */
  private advance(): void {
    if (this.disposed || this.phase !== "live" || !this.session) return;
    const status = this.status?.kind;

    if (status === "suspended" || status === "failed") {
      if (this.queued.size > 0) void this.resume();
      return;
    }
    if (status !== "running") return;

    if (!this.seeded && !this.seeding && this.seedFailure === null) this.seed();

    // A change the runner answered `session_busy` waits out its delay, and so
    // does a Run the change would end.
    if (this.busyTimer) return;
    if (!this.applying && this.agentWanted !== this.agentApplied) {
      void this.applyAgent();
      return;
    }
    if (this.refusedSet && this.desired && !sameAppSet(this.refusedSet, this.desired)) {
      this.refusedSet = null;
      this.setProblem = null;
    }
    if (!this.applying && this.desired && this.desiredReady() && !this.refusedSet) {
      const step = appSetStep(this.applied, this.desired, this.turnActive && this.agentApplied !== null);
      if (step === "apply") {
        void this.applySet(this.desired);
        return;
      }
    }
    if (this.applying || !this.seeded) return;

    for (const [app, waiting] of [...this.queued]) {
      if (!this.applied.some((a) => a.name === app)) continue;
      if (this.slots.get(app)?.state !== "ready") continue;
      this.queued.delete(app);
      void this.startRun(app, waiting);
    }
  }

  private async recheck(): Promise<void> {
    const session = this.session;
    if (!session) return;
    try {
      const document = await session.read();
      if (this.disposed || this.session !== session || document.status.kind === "failed") return;
      this.status = document.status;
      this.subscribe();
      this.changed();
      this.advance();
    } catch (err) {
      if (this.disposed) return;
      this.phase = "failed";
      this.problem = message(err);
      this.changed();
    }
  }

  private async resume(): Promise<void> {
    const session = this.session;
    if (!session || this.applying) return;
    this.applying = true;
    try {
      await session.resume();
      this.status = { kind: "starting" };
      this.subscribe();
    } catch (err) {
      this.failQueued(err);
    } finally {
      this.applying = false;
      this.changed();
    }
  }

  private async startRun(app: string, waiting: QueuedRun): Promise<void> {
    try {
      const runId = await this.liveSession().runApp(app, waiting.request);
      waiting.resolve(runId);
    } catch (err) {
      if (err instanceof RunnerRefusal && err.code === "app_not_ready" && !this.disposed) {
        // The container is being replaced; the next `ready` starts it.
        this.slots.set(app, { state: "pending" });
        this.queued.set(app, waiting);
        this.changed();
        return;
      }
      waiting.reject(err instanceof Error ? err : new Error(message(err)));
    }
    this.changed();
  }

  private failQueued(err: unknown): void {
    const error = err instanceof Error ? err : new Error(message(err));
    for (const waiting of this.queued.values()) waiting.reject(error);
    this.queued.clear();
  }

  private runningApps(names: (name: string) => boolean): void {
    for (const [app, slot] of this.slots) if (slot.state === "running" && names(app)) this.rerun.add(app);
  }

  private async applySet(apps: SessionAppSpec[]): Promise<void> {
    const session = this.liveSession();
    this.applying = true;
    this.setProblem = null;
    this.changed();
    this.runningApps((name) => apps.some((a) => a.name === name));
    try {
      await session.setApps(apps);
      this.busyAttempts = 0;
      const before = new Set(this.applied.map((a) => a.name));
      this.applied = apps;
      for (const app of apps) if (!before.has(app.name)) this.slots.set(app.name, { state: "pending" });
      for (const name of [...this.slots.keys()]) if (!apps.some((a) => a.name === name)) this.slots.delete(name);
    } catch (err) {
      this.rerun.clear();
      if (err instanceof RunnerRefusal && err.code === "session_busy") {
        this.holdWhileBusy();
      } else {
        this.setProblem = err instanceof TeloVersionRefusedError ? teloRefusal(err) : message(err);
        // Not retried until the set changes again: the same set would be refused
        // the same way.
        this.refusedSet = apps;
      }
    } finally {
      this.applying = false;
      this.changed();
      this.advance();
    }
  }

  private async applyAgent(): Promise<void> {
    const session = this.liveSession();
    const wanted = this.agentWanted;
    this.applying = true;
    this.changed();
    this.runningApps(() => true);
    try {
      await session.setAgent(wanted);
      this.busyAttempts = 0;
      this.agentApplied = wanted;
      this.agentAwaitingStatus = true;
    } catch (err) {
      this.rerun.clear();
      if (err instanceof RunnerRefusal && err.code === "session_busy") {
        this.holdWhileBusy();
      } else {
        this.agentWanted = this.agentApplied;
        this.agentProblem = `The session's agent could not be changed: ${message(err)}`;
        this.options.listener.syncFailed(this.agentProblem);
      }
    } finally {
      this.applying = false;
      this.changed();
      this.advance();
    }
  }

  private seed(): void {
    const surface = this.workspaceSurface;
    if (!surface) return;
    this.syncAgain = false;
    this.seeding = seedDelta(surface, this.options.bridge)
      .then(() => {
        this.seeded = true;
      })
      .catch((err: unknown) => {
        if (err instanceof SessionGoneError) {
          this.phase = "failed";
          this.problem = "The runner no longer holds this workspace's session.";
          return;
        }
        // Not retried here: a failed push would retry from `advance` at once,
        // forever. The next write, or a retry from the header, tries again. A
        // Run waiting on it cannot start on files the session does not have, so
        // it ends with the same reason.
        const text = `The workspace could not be synced to its session: ${message(err)}`;
        this.seedFailure = text;
        this.failQueued(new Error(text));
      })
      .finally(() => {
        this.seeding = null;
        if (this.syncAgain && !this.disposed) this.seed();
        this.changed();
        this.advance();
      });
    this.changed();
  }

  private compose(): WorkspaceSessionState {
    const status = this.status;
    const pending: WorkspaceSessionState["appSet"]["pending"] = this.applying
      ? "applying"
      : this.desired && !sameAppSet(this.applied, this.desired) && !this.refusedSet
        ? this.turnActive && this.agentApplied !== null
          ? "turn"
          : status?.kind === "running"
            ? "applying"
            : "session"
        : "none";
    const waiting = new Map<string, RunWait>();
    for (const app of this.queued.keys()) {
      waiting.set(
        app,
        status?.kind !== "running" || !this.seeded
          ? "session"
          : !this.applied.some((a) => a.name === app)
            ? pending === "turn"
              ? "turn"
              : "app-set"
            : "app",
      );
    }
    return {
      capabilities: this.capabilities,
      agentOffered: this.capabilitiesRead ? this.capabilities?.features.agents?.includes(AGENT_APP_NAME) === true : null,
      phase: this.phase,
      problem: this.problem,
      terms: this.terms,
      sessionId: this.session?.id ?? null,
      status,
      progress: this.progress,
      syncProblem: this.seedFailure,
      applied: new Set(this.applied.map((a) => a.name)),
      appSet: { pending, problem: this.setProblem },
      slots: new Map([...this.slots].map(([name, slot]) => [name, { ...slot }])),
      waiting,
      agent: status?.kind === "running" ? (status.agent ?? null) : null,
      agentUnavailable: this.agentUnavailable(),
      inspectUrl: status?.kind === "running" ? (status.inspectUrl ?? null) : null,
      endpoints: status?.kind === "running" ? (status.endpoints ?? []) : [],
      credential: this.credential,
    };
  }

  private agentUnavailable(): string | null {
    const status = this.status;
    if (this.mode !== "agent" || status?.kind !== "running") return null;
    if (this.agentProblem) return this.agentProblem;
    if (this.applying || this.agentAwaitingStatus || this.agentApplied === null) return null;
    if (this.agentWanted !== this.agentApplied) return null;
    return status.agent
      ? null
      : "The runner runs this session's agent but reports no address for it, so it cannot be reached.";
  }

  private changed(): void {
    if (this.disposed) return;
    this.snapshot = this.compose();
    this.options.listener.changed();
  }
}
