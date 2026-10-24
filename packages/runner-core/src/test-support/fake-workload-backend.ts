import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  AppRunRefused,
  type AdoptedWorkload,
  type AppAddresses,
  type AppRun,
  type BackendAppSpec,
  type BackendWorkload,
  type RunnerBackend,
  type WorkloadCallbacks,
  type WorkloadSpec,
  type WorkloadTokens,
} from "../backend.js";
import type { ResolvedRunnerApp, RunnerCoreConfig } from "../config.js";
import type { AppRunEnding, RunnerCapabilities, WorkspaceChangeSet } from "../contract.js";
import { buildServer, type ServerDeps, type ServerHandle } from "../server.js";
import type { SessionContainerEngine } from "../session-containers/session-container-engine.js";
import { SqliteSessionStore } from "../session-store/sqlite-session-store.js";

/**
 * A backend that runs nothing and records everything it was asked, reporting
 * what a real backend reports: `running` with an endpoint per declared port and
 * the agent's, every app `ready`, a run `running` on start and `ready` with its
 * ending on stop.
 */
export class FakeWorkloadBackend implements RunnerBackend {
  readonly created: WorkloadSpec[] = [];
  readonly workloads: FakeWorkload[] = [];
  readonly destroyed: string[] = [];
  readonly reaped: Array<{ known: ReadonlySet<string>; live: ReadonlySet<string> }> = [];
  /** Workloads `adopt` finds, by session id. */
  readonly adoptable = new Map<string, { tokens: WorkloadTokens; live?: Record<string, string> }>();
  /** Set to make `create` reject. */
  failCreate: Error | undefined;
  addresses: (app: string) => AppAddresses = (app) => ({
    inspect: { listen: `0.0.0.0:9230`, url: `http://127.0.0.1:1/${app}/events` },
    host: "127.0.0.1",
  });
  adopt?: RunnerBackend["adopt"] = async (spec, callbacks) => {
    const found = this.adoptable.get(spec.sessionId);
    if (!found) return undefined;
    const workload = this.stand(spec, callbacks, found.tokens);
    for (const [app, runId] of Object.entries(found.live ?? {})) {
      workload.live.set(app, runId);
      callbacks.onAppState(app, { state: "running", runId });
    }
    return { workload, tokens: found.tokens } satisfies AdoptedWorkload;
  };
  readonly containers?: SessionContainerEngine;

  constructor(options: { containers?: SessionContainerEngine } = {}) {
    if (options.containers) this.containers = options.containers;
  }

  async probe() {
    return { status: "ready" as const };
  }

  async create(spec: WorkloadSpec, callbacks: WorkloadCallbacks): Promise<BackendWorkload> {
    this.created.push(spec);
    if (this.failCreate) throw this.failCreate;
    return this.stand(spec, callbacks, spec.tokens);
  }

  async destroy(sessionId: string): Promise<void> {
    this.destroyed.push(sessionId);
  }

  async reapOrphans(sessions: { known: ReadonlySet<string>; live: ReadonlySet<string> }) {
    this.reaped.push(sessions);
  }

  /** The live workload of a session. */
  workloadOf(sessionId: string): FakeWorkload {
    const found = this.workloads.filter((w) => w.sessionId === sessionId && !w.gone).at(-1);
    if (!found) throw new Error(`no live workload for '${sessionId}'`);
    return found;
  }

  private stand(spec: WorkloadSpec, callbacks: WorkloadCallbacks, tokens: WorkloadTokens): FakeWorkload {
    const workload = new FakeWorkload(spec, callbacks, this, tokens);
    this.workloads.push(workload);
    workload.report();
    return workload;
  }
}

export class FakeWorkload implements BackendWorkload {
  readonly sessionId: string;
  apps: BackendAppSpec[];
  agent: ResolvedRunnerApp | undefined;
  readonly runs: Array<{ app: string; run: AppRun }> = [];
  readonly stops: Array<{ app: string; runId: string; graceMs: number }> = [];
  readonly stdin: Array<{ app: string; runId: string; bytes: string }> = [];
  readonly resizes: Array<{ app: string; runId: string; cols: number; rows: number }> = [];
  readonly reloads: string[] = [];
  readonly applied: WorkspaceChangeSet[] = [];
  readonly declaredPorts: Array<{ app: string; ports: number[] }> = [];
  /** Live run id per app. */
  readonly live = new Map<string, string>();
  suspended = false;
  detached = false;
  /** Called inside `setApps` before it reports anything. */
  onSetApps: ((apps: BackendAppSpec[]) => void) | undefined;

  readonly workspace = {
    tree: async () => ({ files: [] }),
    readFile: async () => ({ content: "", size: 0 }),
    apply: async (changes: WorkspaceChangeSet) => {
      this.applied.push(changes);
      return { written: changes.write?.length ?? 0, deleted: changes.delete?.length ?? 0 };
    },
  };

  constructor(
    spec: WorkloadSpec,
    readonly callbacks: WorkloadCallbacks,
    private readonly backend: FakeWorkloadBackend,
    public tokens: WorkloadTokens,
  ) {
    this.sessionId = spec.sessionId;
    this.apps = spec.apps;
    this.agent = spec.agent;
  }

  get gone(): boolean {
    return this.suspended;
  }

  report(): void {
    this.callbacks.onStatus({
      kind: "running",
      endpoints: this.apps.flatMap((a) =>
        a.ports.map((p) => ({ host: "", port: p.port, protocol: p.protocol })),
      ),
      ...(this.agent?.port !== undefined
        ? { agent: { host: "", port: this.agent.port, protocol: "tcp" as const } }
        : {}),
    });
    for (const app of this.apps) this.callbacks.onAppState(app.name, { state: "ready" });
  }

  async addresses(app: string): Promise<AppAddresses> {
    return this.backend.addresses(app);
  }

  async runApp(app: string, run: AppRun): Promise<void> {
    const live = this.live.get(app);
    if (live === run.runId) return;
    if (live !== undefined) throw new AppRunRefused("run_active", `app '${app}' runs ${live}`);
    this.runs.push({ app, run });
    this.live.set(app, run.runId);
    this.callbacks.onAppState(app, { state: "running", runId: run.runId });
  }

  async stopApp(app: string, runId: string, graceMs: number): Promise<void> {
    this.stops.push({ app, runId, graceMs });
    if (this.live.get(app) === runId) this.end(app, { runId, signal: "SIGTERM" });
  }

  /** The live run's process ended. */
  end(app: string, ending: AppRunEnding): void {
    this.live.delete(app);
    this.callbacks.onAppState(app, { state: "ready", ended: ending });
  }

  writeStdin(app: string, runId: string, bytes: Uint8Array): void {
    this.stdin.push({ app, runId, bytes: Buffer.from(bytes).toString() });
  }

  resize(app: string, runId: string, cols: number, rows: number): void {
    this.resizes.push({ app, runId, cols, rows });
  }

  async reload(app: string): Promise<void> {
    this.reloads.push(app);
  }

  applyDeclaredPorts(app: string, ports: Array<{ port: number }>): void {
    this.declaredPorts.push({ app, ports: ports.map((p) => p.port) });
  }

  async setApps(apps: BackendAppSpec[]): Promise<void> {
    this.onSetApps?.(apps);
    this.apps = apps;
    this.live.clear();
    this.report();
  }

  async setAgent(agent: ResolvedRunnerApp | undefined, tokens: WorkloadTokens): Promise<void> {
    this.agent = agent;
    this.tokens = tokens;
    this.live.clear();
    this.report();
  }

  async suspend(): Promise<void> {
    this.suspended = true;
  }

  async detach(): Promise<void> {
    this.detached = true;
  }
}

export const TEST_CAPABILITIES: RunnerCapabilities = {
  displayName: "test",
  description: "test",
  config: { schema: { type: "object" } },
  features: { io: ["tty", "streams"], ports: true },
};

export function testConfig(overrides: Partial<RunnerCoreConfig> = {}): RunnerCoreConfig {
  return {
    port: 0,
    logLevel: "silent",
    maxSessions: 8,
    replayBufferBytes: 100_000,
    corsOrigins: "*",
    sessions: {
      idleMs: 3_600_000,
      maxRunningSeconds: 21_600,
      retentionMs: 3_600_000,
      reloadLimitPerMinute: 30,
    },
    sessionStore: { kind: "sqlite", directory: undefined },
    sessionContainers: { enabled: false, max: 4 },
    ...overrides,
  };
}

/** A SQLite store in a fresh temporary directory. */
export async function temporaryStore(): Promise<{
  store: SqliteSessionStore;
  directory: string;
  reopen(): Promise<SqliteSessionStore>;
  dispose(): Promise<void>;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "runner-core-sessions-"));
  const handle = {
    store: await SqliteSessionStore.open(directory),
    directory,
    reopen: async () => {
      await handle.store.close();
      handle.store = await SqliteSessionStore.open(directory);
      return handle.store;
    },
    dispose: async () => {
      await handle.store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
  return handle;
}

/** A server over the fake backend and a temporary store, plus requests that
 *  carry a session's resume secret. */
export async function bootTestServer(
  deps: Partial<ServerDeps> & { backend?: FakeWorkloadBackend } = {},
  storeHandle?: Awaited<ReturnType<typeof temporaryStore>>,
): Promise<{
  server: ServerHandle;
  backend: FakeWorkloadBackend;
  store: Awaited<ReturnType<typeof temporaryStore>>;
}> {
  const backend = deps.backend ?? new FakeWorkloadBackend();
  const store = storeHandle ?? (await temporaryStore());
  const server = await buildServer({
    config: testConfig(),
    version: "test",
    capabilities: TEST_CAPABILITIES,
    ...deps,
    backend,
    store: store.store,
  });
  return { server, backend, store };
}

/** Wait until every queued store write and event of the session is out. */
export async function settled(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}
