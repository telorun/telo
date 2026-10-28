import { isEventFrame } from "@telorun/debug-wire";

import {
  AppRunRefused,
  type AppAddresses,
  type BackendAppSpec,
  type BackendStatus,
  type BackendWorkload,
  type RunnerBackend,
  type WorkloadCallbacks,
  type WorkloadSpec,
  type WorkloadTokens,
} from "../backend.js";
import type { RunnerAgent, SessionLifecycleConfig } from "../config.js";
import {
  SessionStartError,
  type AppState,
  type IoMode,
  type RunEvent,
  type RunStatus,
  type SessionConfig,
} from "../contract.js";
import { relayDebugStream } from "../debug/relay.js";
import { portsResolvedFrom } from "../debug/ports-resolved.js";
import { RunProjection } from "../debug/run-projection.js";
import { watchReachability } from "../reachability.js";
import type { SessionContainers } from "../session-containers/session-containers.js";
import type {
  ChangeOwnerResult,
  SessionOwner,
  SessionRecord,
  SessionRecordUpdate,
  SessionStore,
  StoredSessionApp,
} from "../session-store/session-store.js";
import { agentPortClash } from "./app-set.js";
import type { IoTickets } from "./io-tickets.js";
import type { AppChannel, SessionEntry, SessionRegistry } from "./registry.js";
import { generateSessionId, randomBase32 } from "./session-id.js";
import { SessionRefusal } from "./session-refusal.js";
import { generateWorkloadToken, statusWithTokens } from "./workload-token.js";

/** How long a stopped run may take to end before it is killed. */
export const STOP_GRACE_MS = 10_000;

/** How often the lifecycle wakes: its windows are minutes long. */
const TICK_MS = 5_000;

/** The waits between attempts of one record write. Bounded: a store that does
 *  not come back fails the session rather than holding it. */
const STORE_RETRY_DELAYS_MS = [100, 500, 2_000];

/** A record write that failed after every retry. The session is already
 *  failed on its stream with the store's error when this is thrown. */
class StoreWriteFailed extends SessionRefusal {
  constructor(message: string) {
    super(500, "session_store_failed", message);
  }
}

export interface SessionLifecycleDeps {
  backend: RunnerBackend;
  store: SessionStore;
  registry: SessionRegistry;
  tickets: IoTickets;
  containers?: SessionContainers;
  /** The operator's co-resident agent (`AGENT_*`), the one a session may name. */
  agent: RunnerAgent | undefined;
  settings: SessionLifecycleConfig;
  /** Most RUNNING (or starting) sessions at once. */
  maxSessions: number;
  log: {
    info(obj: unknown, msg: string): void;
    warn(obj: unknown, msg: string): void;
    error(obj: unknown, msg: string): void;
    debug(obj: unknown, msg: string): void;
  };
  now?: () => number;
  /** Waits between attempts of a record write; defaults to {@link STORE_RETRY_DELAYS_MS}. */
  storeRetryDelaysMs?: readonly number[];
}

export interface CreateArgs {
  owner: SessionOwner;
  workspace: string;
  apps: BackendAppSpec[];
  agent: RunnerAgent | undefined;
  config: SessionConfig;
  /** Things decided about the session the client would otherwise infer from an
   *  absence, emitted on its stream. */
  notices: string[];
}

export type CreateOutcome = { kind: "created"; entry: SessionEntry } | { kind: "exists"; id: string };

export interface RunArgs {
  env: Record<string, string>;
  io: IoMode;
  cols?: number;
  rows?: number;
}

/**
 * A session's life, with the store as the authority over its record: every
 * record change is written to the store before the live entry or the event
 * stream shows it. The live half — streams, rings, the backend workload, the
 * runs — is the registry's.
 */
export class SessionLifecycle {
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  /** Creates admitted against the ceiling and not yet registered. */
  private reserved = 0;
  /** Per-session queue of store writes and the events ordered behind them. */
  private readonly outbox = new Map<string, { tail: Promise<void>; depth: number }>();

  constructor(private readonly deps: SessionLifecycleDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  // ---- Boot and shutdown ---------------------------------------------------

  /**
   * Load every stored session. A `running` (or `starting`) one is adopted when
   * the backend still holds its workload, and suspended when it does not; then
   * the backend's orphan sweep runs, sparing every known session's storage and
   * every adopted workload.
   */
  async boot(): Promise<void> {
    const records = await this.deps.store.listAll();
    const live = new Set<string>();
    for (const record of records) {
      const wasLive = record.status === "running" || record.status === "starting";
      const entry = this.register(
        record,
        wasLive ? { kind: "starting" } : storedStatus(record),
        wasLive ? record.containerEngine : null,
      );
      if (!wasLive) continue;
      if (await this.adopt(entry)) live.add(entry.sessionId);
    }
    await this.deps.backend.reapOrphans?.({
      known: new Set(records.map((r) => r.id)),
      live,
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  /** The runner process is ending: release every live workload without
   *  stopping what outlives the runner. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all(
      this.deps.registry.list().map(async (entry) => {
        for (const channel of entry.apps.values()) channel.run?.abort.abort();
        const workload = entry.workload;
        if (!workload) return;
        try {
          await workload.detach();
        } catch (err) {
          this.deps.log.warn({ err, sessionId: entry.sessionId }, "failed to detach a session's workload");
        }
      }),
    );
    await Promise.all([...this.outbox.values()].map((o) => o.tail));
  }

  // ---- Creating --------------------------------------------------------------

  async create(args: CreateArgs): Promise<CreateOutcome> {
    this.admitRunning();
    this.reserved += 1;
    let entry: SessionEntry;
    try {
      const now = new Date(this.now());
      const created = await this.deps.store.create({
        id: generateSessionId(),
        owner: args.owner,
        workspace: args.workspace,
        agent: args.agent?.name ?? null,
        apps: args.apps.map(storedApp),
        config: args.config,
        status: "starting",
        createdAt: now,
        lastActiveAt: now,
        suspendedAt: null,
        containerEngine: null,
      });
      if (created.kind === "exists") return created;
      entry = this.register(created.record, { kind: "starting" });
    } finally {
      this.reserved -= 1;
    }
    this.deps.registry.emit(entry.sessionId, { type: "status", status: { kind: "starting" } });
    for (const message of args.notices) {
      this.deps.registry.emit(entry.sessionId, { type: "progress", phase: "provision", message });
    }
    this.startWorkload(entry);
    return { kind: "created", entry };
  }

  // ---- Suspend, resume, delete ----------------------------------------------

  async suspend(entry: SessionEntry): Promise<void> {
    this.requireIdleTransition(entry);
    const workload = entry.workload;
    if (entry.status.kind !== "running" || !workload) {
      throw new SessionRefusal(409, "not_running", `session '${entry.sessionId}' is not running`);
    }
    entry.busy = "suspending";
    try {
      await workload.suspend();
      this.endRuns(entry, "the session was suspended");
      this.dropWorkload(entry);
      await this.commitStatus(entry, { kind: "suspended" }, { suspendedAt: new Date(this.now()) });
    } finally {
      entry.busy = null;
    }
  }

  async resume(entry: SessionEntry): Promise<void> {
    this.requireIdleTransition(entry);
    if (entry.status.kind !== "suspended" && entry.status.kind !== "failed") {
      throw new SessionRefusal(
        409,
        "not_suspended",
        `session '${entry.sessionId}' is ${entry.status.kind}, so there is nothing to resume`,
      );
    }
    this.admitRunning();
    entry.busy = "starting";
    try {
      await this.commitStatus(entry, { kind: "starting" }, { suspendedAt: null });
    } catch (err) {
      entry.busy = null;
      throw err;
    }
    this.startWorkload(entry);
  }

  /** Delete the session, its workload and its storage. */
  async delete(entry: SessionEntry): Promise<void> {
    this.requireIdleTransition(entry);
    entry.busy = "deleting";
    try {
      const workload = entry.workload;
      if (workload) {
        await workload.suspend();
        this.endRuns(entry, "the session was deleted");
        this.dropWorkload(entry);
      }
      await this.deps.backend.destroy(entry.sessionId);
      await this.deps.store.delete(entry.sessionId);
    } catch (err) {
      entry.busy = null;
      throw err;
    }
    this.deps.tickets.forget(entry.sessionId);
    await this.drain(entry.sessionId);
    this.deps.registry.emit(entry.sessionId, { type: "status", status: { kind: "stopped" } });
    this.deps.registry.remove(entry.sessionId);
    this.outbox.delete(entry.sessionId);
  }

  // ---- The app set and the agent ---------------------------------------------

  /** Replace the app set: written to the store, then applied to a live
   *  workload, which every live run ends with. */
  async setApps(entry: SessionEntry, apps: BackendAppSpec[]): Promise<void> {
    this.requireIdleTransition(entry);
    if (entry.status.kind === "starting") {
      throw new SessionRefusal(409, "session_busy", `session '${entry.sessionId}' is starting`);
    }
    const agent = this.recordedAgent(entry);
    const clash = agent && agentPortClash(agent, apps);
    if (agent && clash) {
      throw new SessionRefusal(
        400,
        "port_conflict",
        `app '${clash.name}' declares tcp port ${agent.port}, which the session's agent ` +
          `'${agent.name}' listens on`,
      );
    }
    entry.busy = "apps";
    try {
      await this.commitRecord(entry, { apps: apps.map(storedApp) });
      for (const app of apps) {
        if (!entry.apps.has(app.name)) {
          this.deps.registry.addApp(entry, { name: app.name, ports: app.ports });
        }
      }
      const workload = entry.workload;
      if (workload) {
        this.endRuns(entry, "the app set changed");
        // The applications that started containers are replaced, and nothing
        // of theirs survives to remove what they started.
        await this.deps.containers?.release(entry.sessionId, { close: false });
        try {
          await workload.setApps(apps);
        } catch (err) {
          await this.fail(entry, entry.epoch, `changing the app set failed: ${messageOf(err)}`);
          throw new SessionRefusal(500, "set_apps_failed", messageOf(err));
        }
      }
      for (const name of [...entry.apps.keys()]) {
        if (!apps.some((a) => a.name === name)) entry.apps.delete(name);
      }
      for (const app of apps) entry.apps.get(app.name)!.ports = app.ports;
    } finally {
      entry.busy = null;
    }
  }

  /** Replace the co-resident agent; a live workload is recreated with it. */
  async setAgent(entry: SessionEntry, agent: RunnerAgent | undefined): Promise<void> {
    this.requireIdleTransition(entry);
    if (entry.status.kind === "starting") {
      throw new SessionRefusal(409, "session_busy", `session '${entry.sessionId}' is starting`);
    }
    entry.busy = "agent";
    try {
      await this.commitRecord(entry, { agent: agent?.name ?? null });
      const workload = entry.workload;
      if (!workload) return;
      this.endRuns(entry, "the session's agent changed");
      await this.deps.containers?.release(entry.sessionId, { close: false });
      const minted = mintAgentToken(agent);
      entry.agent = minted.agent;
      entry.tokens = minted.tokens;
      try {
        await workload.setAgent(minted.agent, minted.tokens);
      } catch (err) {
        await this.fail(entry, entry.epoch, `changing the agent failed: ${messageOf(err)}`);
        throw new SessionRefusal(500, "set_agent_failed", messageOf(err));
      }
    } finally {
      entry.busy = null;
    }
  }

  // ---- Runs ------------------------------------------------------------------

  /** Start one app. Resolves with the run's id once its process started. */
  async run(entry: SessionEntry, appName: string, args: RunArgs): Promise<{ runId: string }> {
    const workload = this.liveWorkload(entry);
    const channel = this.channelOf(entry, appName);
    if (channel.run) {
      throw new SessionRefusal(409, "run_active", `app '${appName}' already has a live run`, {
        runId: channel.run.runId,
      });
    }
    if (channel.state !== "ready") {
      throw new SessionRefusal(409, "app_not_ready", `app '${appName}' is not ready yet`);
    }
    const app = entry.record.apps.find((a) => a.name === appName)!;
    const runId = randomBase32(16);
    const run = { runId, io: args.io, started: false, abort: new AbortController() };
    channel.run = run;
    try {
      const addresses = await workload.addresses(appName);
      this.addressesOf.set(run, addresses);
      entry.attribution?.expect(appName, "run");
      await workload.runApp(appName, {
        runId,
        argv: runArgv(addresses, app.entryRelativePath),
        env: {
          ...withoutCacheOverride(args.env),
          ...this.deps.containers?.envOf(entry.sessionId),
        },
        cwd: ".",
        io: args.io,
        ...(args.cols !== undefined ? { cols: args.cols } : {}),
        ...(args.rows !== undefined ? { rows: args.rows } : {}),
      });
    } catch (err) {
      if (channel.run === run) {
        run.abort.abort();
        channel.run = null;
        entry.attribution?.endGeneration(appName, { reason: messageOf(err) });
      }
      if (err instanceof AppRunRefused) {
        throw new SessionRefusal(409, err.code, err.message);
      }
      throw new SessionRefusal(500, "run_failed", `app '${appName}' did not start: ${messageOf(err)}`);
    }
    await this.commitRecord(entry, {});
    return { runId };
  }

  /** End an app's live run. Resolves with its id, or undefined when none is live. */
  async stop(entry: SessionEntry, appName: string): Promise<string | undefined> {
    const channel = this.channelOf(entry, appName);
    const run = channel.run;
    if (!run || !entry.workload) return undefined;
    await entry.workload.stopApp(appName, run.runId, STOP_GRACE_MS);
    return run.runId;
  }

  /** Bytes for an app's live run; dropped when nothing runs. */
  writeStdin(entry: SessionEntry, appName: string, bytes: Uint8Array): void {
    const run = entry.apps.get(appName)?.run;
    if (run?.started) entry.workload?.writeStdin(appName, run.runId, bytes);
  }

  resize(entry: SessionEntry, appName: string, cols: number, rows: number): void {
    const run = entry.apps.get(appName)?.run;
    if (run?.started && run.io === "tty") entry.workload?.resize(appName, run.runId, cols, rows);
  }

  // ---- Ownership -------------------------------------------------------------

  /** Gives the session a new owner, in the store first; the old credential
   *  stops working the moment the live record shows the new one. */
  async changeOwner(entry: SessionEntry, owner: SessionOwner): Promise<ChangeOwnerResult> {
    let result: ChangeOwnerResult = { kind: "not_found" };
    await this.enqueue(entry, async () => {
      result = await this.deps.store.changeOwner(entry.sessionId, owner);
      if (result.kind === "changed") entry.record = result.record;
    });
    return result;
  }

  // ---- Background ------------------------------------------------------------

  /** Idle and running-limit suspends, retention, and expired DPoP `jti`s.
   *  Exposed for tests. */
  async tick(): Promise<void> {
    const now = this.now();
    const { idleMs, maxRunningSeconds, retentionMs } = this.deps.settings;
    const jobs: Promise<void>[] = [
      this.deps.store.purgeExpiredJtis(new Date(now)).then(
        () => undefined,
        (err) => this.deps.log.error({ err }, "purging expired DPoP proof ids failed"),
      ),
    ];
    for (const entry of this.deps.registry.list()) {
      if (entry.busy) continue;
      if (entry.status.kind === "running" && entry.workload) {
        const idle =
          entry.subscribers === 0 && entry.idleSince !== null && now - entry.idleSince >= idleMs;
        const overRunning =
          entry.runningSince !== null && now - entry.runningSince >= maxRunningSeconds * 1000;
        if (idle || overRunning) {
          jobs.push(
            this.suspend(entry).catch((err) =>
              this.deps.log.error(
                { err, sessionId: entry.sessionId },
                idle ? "idle suspend failed" : "running-limit suspend failed",
              ),
            ),
          );
        }
        continue;
      }
      const lostAt = entry.record.suspendedAt?.getTime();
      if (
        (entry.status.kind === "suspended" || entry.status.kind === "failed") &&
        lostAt !== undefined &&
        now - lostAt >= retentionMs
      ) {
        jobs.push(
          this.delete(entry).catch((err) =>
            this.deps.log.error({ err, sessionId: entry.sessionId }, "retention purge failed"),
          ),
        );
      }
    }
    await Promise.all(jobs);
  }

  /** Running sessions, the ones the ceiling bounds. */
  runningCount(): number {
    return this.deps.registry
      .list()
      .filter((e) => e.status.kind === "starting" || e.status.kind === "running").length;
  }

  // ---- Internals -------------------------------------------------------------

  /** Where each run's process is reached, kept beside the run. */
  private readonly addressesOf = new WeakMap<object, AppAddresses>();
  /** The epoch of the workload creation in flight, per session. */
  private readonly starting = new WeakMap<SessionEntry, number>();

  /** `containers` is what a previous runner process stored of a session whose
   *  workload may still run, and so still use them. */
  private register(
    record: SessionRecord,
    status: RunStatus,
    containers: SessionRecord["containerEngine"] = null,
  ): SessionEntry {
    const entry = this.deps.registry.register(record, status);
    entry.attribution = new RunProjection(this.deps.registry, record.id);
    this.deps.containers?.open(record.id, containers);
    return entry;
  }

  private admitRunning(): void {
    if (this.runningCount() + this.reserved >= this.deps.maxSessions) {
      throw new SessionRefusal(
        429,
        "too_many_sessions",
        `runner is at its configured max of ${this.deps.maxSessions} running sessions`,
      );
    }
  }

  private requireIdleTransition(entry: SessionEntry): void {
    if (entry.busy) {
      throw new SessionRefusal(
        409,
        "session_busy",
        `session '${entry.sessionId}' is ${entry.busy}; try again once it settles`,
      );
    }
  }

  private liveWorkload(entry: SessionEntry): BackendWorkload {
    if (entry.status.kind !== "running" || !entry.workload) {
      throw new SessionRefusal(409, "not_running", `session '${entry.sessionId}' is not running`);
    }
    return entry.workload;
  }

  private channelOf(entry: SessionEntry, appName: string): AppChannel {
    const channel = entry.apps.get(appName);
    if (!channel) {
      throw new SessionRefusal(404, "unknown_app", `session runs no app named '${appName}'`);
    }
    return channel;
  }

  /** Create the workload in the background; the client follows on the stream.
   *  The session stays busy until the creation settles, even past a failure
   *  reported on the way, so two creations never overlap. */
  private startWorkload(entry: SessionEntry): void {
    entry.busy = "starting";
    const epoch = ++entry.epoch;
    this.starting.set(entry, epoch);
    const minted = mintAgentToken(this.recordedAgent(entry));
    entry.agent = minted.agent;
    entry.tokens = minted.tokens;
    const spec = this.workloadSpec(entry, minted.tokens);
    this.deps.backend
      .create(spec, this.callbacks(entry, epoch))
      .then(async (workload) => {
        if (entry.epoch !== epoch || !this.deps.registry.has(entry.sessionId)) {
          await workload.suspend();
          return;
        }
        entry.workload = workload;
        this.armAdopted(entry);
      })
      .catch((err) => {
        const message =
          err instanceof SessionStartError
            ? `${err.stage}: ${err.message}${err.daemonMessage ? ` (${err.daemonMessage})` : ""}`
            : messageOf(err);
        this.deps.log.error({ err, sessionId: entry.sessionId }, "session workload creation failed");
        return this.fail(entry, epoch, message);
      })
      .finally(() => {
        if (this.starting.get(entry) !== epoch) return;
        this.starting.delete(entry);
        entry.busy = null;
      });
  }

  /** Take over the workload of a session stored as running. True when it lives. */
  private async adopt(entry: SessionEntry): Promise<boolean> {
    const adopt = this.deps.backend.adopt?.bind(this.deps.backend);
    if (!adopt) {
      await this.reported(
        this.commitStatus(entry, { kind: "suspended" }, { suspendedAt: new Date(this.now()) }),
      );
      return false;
    }
    const epoch = ++entry.epoch;
    const agent = this.recordedAgent(entry);
    // The running status waits for the adopted tokens: until the backend
    // answers, core does not know the agent's.
    let held: BackendStatus | undefined;
    let holding = true;
    const callbacks = this.callbacks(entry, epoch);
    const adoptCallbacks: WorkloadCallbacks = {
      ...callbacks,
      onStatus: (status) => {
        if (holding && status.kind === "running") held = status;
        else callbacks.onStatus(status);
      },
    };
    try {
      const adopted = await adopt(this.workloadSpec(entry, {}, agent), adoptCallbacks);
      holding = false;
      if (!adopted) {
        await this.reported(
          this.commitStatus(entry, { kind: "suspended" }, { suspendedAt: new Date(this.now()) }),
        );
        return false;
      }
      entry.workload = adopted.workload;
      entry.tokens = adopted.tokens;
      entry.agent = agent && withToken(agent, adopted.tokens.agent);
      if (held) callbacks.onStatus(held);
      this.armAdopted(entry);
      return true;
    } catch (err) {
      holding = false;
      this.deps.log.error({ err, sessionId: entry.sessionId }, "adopting a session's workload failed");
      await this.fail(entry, epoch, `the runner restarted and could not adopt the session: ${messageOf(err)}`);
      return false;
    }
  }

  /** The agent the record names, as the runner offers it now. */
  private recordedAgent(entry: SessionEntry): RunnerAgent | undefined {
    const name = entry.record.agent;
    if (name === null) return undefined;
    const agent = this.deps.agent?.name === name ? this.deps.agent : undefined;
    if (!agent) {
      this.deps.registry.emit(entry.sessionId, {
        type: "progress",
        phase: "provision",
        message: `co-resident agent '${name}' was not started: this runner no longer offers it`,
      });
    }
    return agent;
  }

  private workloadSpec(
    entry: SessionEntry,
    tokens: WorkloadTokens,
    agent: RunnerAgent | undefined = entry.agent,
  ): WorkloadSpec {
    return {
      sessionId: entry.sessionId,
      apps: entry.record.apps.map((a) => ({
        name: a.name,
        entryRelativePath: a.entryRelativePath,
        ports: a.ports,
        ...(a.telo !== undefined ? { telo: a.telo } : {}),
      })),
      ...(agent ? { agent } : {}),
      config: entry.record.config,
      tokens,
    };
  }

  /** The callbacks of one workload creation; anything a replaced workload
   *  reports afterwards is ignored. */
  private callbacks(entry: SessionEntry, epoch: number): WorkloadCallbacks {
    const live = (): boolean =>
      entry.epoch === epoch && this.deps.registry.get(entry.sessionId) === entry;
    const sessionId = entry.sessionId;
    return {
      onStatus: (status) => {
        if (!live()) return;
        if (status.kind === "failed") {
          void this.fail(entry, epoch, status.message);
          return;
        }
        if (entry.runningSince === null) entry.runningSince = this.now();
        void this.reported(this.commitStatus(entry, statusWithTokens(status, entry.tokens)));
      },
      onProgress: (phase, message, done, app) => {
        if (!live()) return;
        this.publish(entry, { type: "progress", app, phase, message, done });
      },
      onAppState: (appName, state) => {
        if (!live()) return;
        this.appState(entry, appName, state);
      },
      onOutput: (appName, chunk, stream) => {
        if (!live()) return;
        this.deps.registry.pushBytes(sessionId, appName, chunk, stream);
      },
      onRoute: (appName, route) => {
        if (!live()) return;
        this.publish(entry, { type: "route", ...(appName ? { app: appName } : {}), ...route });
      },
      onEndpoints: (appName, change) => {
        if (!live()) return;
        const channel = entry.apps.get(appName);
        if (channel) {
          const removed = new Set((change.removed ?? []).map((e) => `${e.protocol}/${e.port}`));
          channel.ports = [
            ...channel.ports.filter((p) => !removed.has(`${p.protocol}/${p.port}`)),
            ...(change.added ?? []).map((e) => ({ port: e.port, protocol: e.protocol })),
          ];
          const added = (change.added ?? []).filter((e) => e.protocol === "tcp").map((e) => e.port);
          if (channel.run?.started && added.length > 0) this.watchPorts(entry, channel, added);
        }
        this.publish(entry, { type: "endpoints", app: appName, ...change });
      },
    };
  }

  private appState(entry: SessionEntry, appName: string, state: AppState): void {
    const channel = entry.apps.get(appName);
    if (!channel) return;
    if (state.state === "running") {
      if (channel.run?.runId === state.runId && channel.run.started) return;
      if (channel.run && channel.run.runId !== state.runId) channel.run.abort.abort();
      const run =
        channel.run?.runId === state.runId
          ? channel.run
          : { runId: state.runId, io: channel.run?.io ?? "tty", started: false, abort: new AbortController() };
      run.started = true;
      channel.run = run;
      channel.state = "running";
      this.publish(entry, { type: "app", app: appName, state: "running", runId: state.runId });
      this.arm(entry, channel);
      return;
    }
    const run = channel.run;
    if (run && (!state.ended || state.ended.runId === run.runId)) {
      run.abort.abort();
      channel.run = null;
      const { code, signal, reason } = state.ended ?? { reason: "the run ended" };
      entry.attribution?.endGeneration(appName, { code, signal, reason });
    }
    channel.state = "ready";
    this.publish(entry, { type: "app", app: appName, ...state });
  }

  /** Relay a started run's debug stream and watch its ports, until it ends. The
   *  relay is fresh per process, so a new kernel's `Kernel.Starting` is never
   *  skipped as already seen. */
  private arm(entry: SessionEntry, channel: AppChannel): void {
    const run = channel.run;
    const workload = entry.workload;
    if (!run) return;
    const known = this.addressesOf.get(run);
    // An adopted run's addresses are asked once the workload is in hand.
    if (!known && !workload) return;
    const resolve = known ? Promise.resolve(known) : workload!.addresses(channel.name);
    void resolve.then(
      (addresses) => {
        if (run.abort.signal.aborted) return;
        this.addressesOf.set(run, addresses);
        void relayDebugStream({
          url: addresses.inspect.url,
          signal: run.abort.signal,
          onFrame: (frame) => {
            entry.attribution?.frame(channel.name, frame);
            if (isEventFrame(frame)) {
              this.publish(entry, { type: "debug", app: channel.name, frame });
            }
            const declared = portsResolvedFrom(frame);
            if (declared) entry.workload?.applyDeclaredPorts?.(channel.name, declared);
          },
          onError: (err) =>
            this.deps.log.debug(
              { err, sessionId: entry.sessionId, app: channel.name },
              "debug stream not answering yet",
            ),
        });
        const tcp = channel.ports.filter((p) => p.protocol === "tcp").map((p) => p.port);
        if (tcp.length > 0) this.watchPorts(entry, channel, tcp);
      },
      (err) =>
        this.deps.log.error(
          { err, sessionId: entry.sessionId, app: channel.name },
          "the backend could not say where a running app is reached",
        ),
    );
  }

  private watchPorts(entry: SessionEntry, channel: AppChannel, ports: number[]): void {
    const run = channel.run;
    const addresses = run && this.addressesOf.get(run);
    if (!run || !addresses) return;
    void watchReachability({
      host: addresses.host,
      ports,
      signal: run.abort.signal,
      onState: (port, state) => {
        if (run.abort.signal.aborted) return;
        this.publish(entry, { type: "reachability", app: channel.name, port, state });
      },
    });
  }

  /** Arm every run an adopted workload reported live before core held it. */
  private armAdopted(entry: SessionEntry): void {
    for (const channel of entry.apps.values()) {
      if (channel.run?.started && !this.addressesOf.has(channel.run)) this.arm(entry, channel);
    }
  }

  /** End every run because the workload under it goes away. */
  private endRuns(entry: SessionEntry, reason: string): void {
    for (const channel of entry.apps.values()) {
      const run = channel.run;
      channel.state = "pending";
      if (!run) continue;
      run.abort.abort();
      channel.run = null;
      entry.attribution?.endGeneration(channel.name, { reason });
    }
  }

  private dropWorkload(entry: SessionEntry): void {
    entry.workload = null;
    entry.epoch += 1;
    entry.runningSince = null;
  }

  /** The workload failed: remove what is left of it, keep the storage, and
   *  record the failure — `resume` rebuilds it. */
  private async fail(entry: SessionEntry, epoch: number, message: string): Promise<void> {
    if (entry.epoch !== epoch || this.deps.registry.get(entry.sessionId) !== entry) return;
    this.endRuns(entry, message);
    const workload = entry.workload;
    this.dropWorkload(entry);
    if (workload) {
      try {
        await workload.suspend();
      } catch (err) {
        this.deps.log.error(
          { err, sessionId: entry.sessionId },
          "failed to remove what was left of a failed session's workload",
        );
      }
    }
    await this.reported(
      this.commitStatus(entry, { kind: "failed", message }, { suspendedAt: new Date(this.now()) }),
    );
  }

  /** Write a status to the store, then show it. */
  private commitStatus(
    entry: SessionEntry,
    status: RunStatus,
    extra: Pick<SessionRecordUpdate, "suspendedAt"> = {},
  ): Promise<void> {
    return this.enqueue(entry, async () => {
      await this.committed(entry, { status: status.kind, ...extra });
      this.deps.registry.emit(entry.sessionId, { type: "status", status });
    });
  }

  /** Write a record change (and the activity it is) to the store. */
  private commitRecord(entry: SessionEntry, changes: SessionRecordUpdate): Promise<void> {
    return this.enqueue(entry, () => this.committed(entry, changes));
  }

  /** A queued record write: retried, and once every attempt failed the session
   *  is failed with the store's error and {@link StoreWriteFailed} thrown. */
  private async committed(entry: SessionEntry, changes: SessionRecordUpdate): Promise<void> {
    try {
      await this.writeRecord(entry, changes);
    } catch (err) {
      throw new StoreWriteFailed(await this.storeFailed(entry, err));
    }
  }

  private async writeRecord(entry: SessionEntry, changes: SessionRecordUpdate): Promise<void> {
    const delays = this.deps.storeRetryDelaysMs ?? STORE_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        const updated = await this.deps.store.update(entry.sessionId, {
          ...changes,
          lastActiveAt: new Date(this.now()),
        });
        if (updated) entry.record = updated;
        return;
      } catch (err) {
        if (attempt >= delays.length) throw err;
        this.deps.log.warn(
          { err, sessionId: entry.sessionId, attempt: attempt + 1 },
          "writing the session record failed; retrying",
        );
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  }

  /**
   * A record write failed for good. A session whose record cannot be written is
   * not durable, so it is failed — its runs ended, its workload removed, its
   * storage kept — with the store's error on its stream; `resume` rebuilds it
   * once the store takes writes again. The failed status is then written too,
   * queued behind the write that failed; until it is, the store keeps the
   * session's earlier status, which a restart reads as a workload to adopt or
   * suspend. Returns the message the stream shows.
   */
  private async storeFailed(entry: SessionEntry, err: unknown): Promise<string> {
    const message = `the session record could not be written to the session store: ${messageOf(err)}`;
    this.deps.log.error({ err, sessionId: entry.sessionId }, "writing the session record failed; failing the session");
    if (this.deps.registry.get(entry.sessionId) !== entry) return message;
    this.endRuns(entry, message);
    const workload = entry.workload;
    this.dropWorkload(entry);
    if (workload) {
      try {
        await workload.suspend();
      } catch (suspendErr) {
        this.deps.log.error(
          { err: suspendErr, sessionId: entry.sessionId },
          "failed to remove the workload of a session whose record could not be written",
        );
      }
    }
    this.deps.registry.emit(entry.sessionId, { type: "status", status: { kind: "failed", message } });
    this.enqueue(entry, () =>
      this.writeRecord(entry, { status: "failed", suspendedAt: new Date(this.now()) }),
    ).catch((writeErr) =>
      this.deps.log.error(
        { err: writeErr, sessionId: entry.sessionId },
        "the session's failed status could not be written either; the store keeps its earlier status",
      ),
    );
    return message;
  }

  /** Settle a write nothing waits on. A {@link StoreWriteFailed} is already on
   *  the session's stream and in the log; anything else is logged here. */
  private async reported(write: Promise<void>): Promise<void> {
    try {
      await write;
    } catch (err) {
      if (err instanceof StoreWriteFailed) return;
      this.deps.log.error({ err }, "a session record write failed");
    }
  }

  /** An event ordered behind any store write still in flight for the session,
   *  so a status the store has not yet taken is never overtaken. */
  private publish(entry: SessionEntry, event: RunEvent): void {
    const queued = this.outbox.get(entry.sessionId);
    if (!queued || queued.depth === 0) {
      this.deps.registry.emit(entry.sessionId, event);
      return;
    }
    void this.enqueue(entry, async () => {
      this.deps.registry.emit(entry.sessionId, event);
    });
  }

  private enqueue(entry: SessionEntry, job: () => Promise<void>): Promise<void> {
    let queued = this.outbox.get(entry.sessionId);
    if (!queued) {
      queued = { tail: Promise.resolve(), depth: 0 };
      this.outbox.set(entry.sessionId, queued);
    }
    const box = queued;
    box.depth += 1;
    const result = box.tail.then(job);
    // The tail only orders the queue; the job's own failure goes to whoever
    // awaits `result`.
    box.tail = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        box.depth -= 1;
      });
    return result;
  }

  private async drain(sessionId: string): Promise<void> {
    await this.outbox.get(sessionId)?.tail;
  }
}

/** `telo run --watch --no-input --inspect <addr> --no-open <entry>`: what a
 *  runner asks of a telo, gated by `MIN_SUPERVISABLE_TELO`. */
function runArgv(addresses: AppAddresses, entry: string): string[] {
  return ["telo", "run", "--watch", "--no-input", "--inspect", addresses.inspect.listen, "--no-open", entry];
}

function storedApp(app: BackendAppSpec): StoredSessionApp {
  return {
    name: app.name,
    entryRelativePath: app.entryRelativePath,
    ports: app.ports.map((p) => ({ port: p.port, protocol: p.protocol })),
    ...(app.telo !== undefined ? { telo: app.telo } : {}),
  };
}

function storedStatus(record: SessionRecord): RunStatus {
  switch (record.status) {
    case "failed":
      return { kind: "failed", message: "the session failed before the runner last restarted" };
    case "stopped":
      return { kind: "stopped" };
    default:
      return { kind: "suspended" };
  }
}

/** A fresh token for the agent's `tokenEnv`, minted per workload creation. */
function mintAgentToken(agent: RunnerAgent | undefined): {
  agent: RunnerAgent | undefined;
  tokens: WorkloadTokens;
} {
  if (agent?.tokenEnv === undefined) return { agent, tokens: {} };
  const token = generateWorkloadToken();
  return { agent: withToken(agent, token), tokens: { agent: token } };
}

function withToken(agent: RunnerAgent, token: string | undefined): RunnerAgent {
  if (agent.tokenEnv === undefined || token === undefined) return agent;
  return { ...agent, env: { ...agent.env, [agent.tokenEnv]: token } };
}

/**
 * Drop a client-supplied `TELO_CACHE_DIR`: it OUTRANKS the
 * `telo-workspace.yaml` marker the session seeds at its workspace root, so it
 * would silently give an app a module cache of its own.
 */
function withoutCacheOverride(env: Record<string, string>): Record<string, string> {
  if (!("TELO_CACHE_DIR" in env)) return env;
  const rest = { ...env };
  delete rest.TELO_CACHE_DIR;
  return rest;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
