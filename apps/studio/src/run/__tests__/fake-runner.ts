import type { WorkspaceBridge } from "../../agent/types";
import type { ResumeSecretScope, ResumeSecretStore, RunnerCredentials } from "../runner-credentials";
import {
  RunnerRefusal,
  SessionGoneError,
  type CreateSessionRequest,
  type CreatedSession,
  type RunAdapter,
  type RunAppRequest,
  type RunEvent,
  type RunnerCapabilities,
  type RunnerConnection,
  type RunnerSession,
  type RunStatus,
  type SequencedRunIo,
  type SessionAppSpec,
  type SessionDocument,
} from "../types";

/** One session the fake runner holds, driven by the test. */
export class FakeSession implements RunnerSession {
  status: RunStatus = { kind: "starting" };
  agent: string | null;
  readonly setAppsCalls: SessionAppSpec[][] = [];
  readonly runCalls: Array<{ app: string; request: RunAppRequest }> = [];
  readonly stopCalls: string[] = [];
  private readonly listeners = new Set<(event: RunEvent) => void>();
  private readonly states = new Map<string, { state: "pending" | "ready" | "running"; runId?: string }>();
  private runs = 0;

  constructor(
    readonly id: string,
    public apps: SessionAppSpec[],
    agent: string | null,
  ) {
    this.agent = agent;
    for (const app of apps) this.states.set(app.name, { state: "pending" });
  }

  emit(event: RunEvent): void {
    if (event.type === "status") this.status = event.status;
    if (event.type === "app") {
      this.states.set(event.app, event.state === "running" ? { state: "running", runId: event.runId } : { state: "ready" });
    }
    for (const listener of [...this.listeners]) listener(event);
  }

  /** The workload is up: every app ready. */
  up(): void {
    this.emit({ type: "status", status: { kind: "running" } });
    for (const app of this.apps) this.emit({ type: "app", app: app.name, state: "ready" });
  }

  async read(): Promise<SessionDocument> {
    return {
      sessionId: this.id,
      workspace: "ws",
      status: this.status,
      agent: this.agent,
      apps: this.apps.map((a) => ({
        name: a.name,
        entryRelativePath: a.entryRelativePath,
        ports: a.ports ?? [],
        ...(a.telo ? { telo: a.telo } : {}),
        state: this.states.get(a.name)?.state ?? "pending",
        ...(this.states.get(a.name)?.runId ? { runId: this.states.get(a.name)!.runId } : {}),
        generation: 0,
      })),
    };
  }
  async resume() {
    this.emit({ type: "status", status: { kind: "starting" } });
  }
  async suspend() {
    this.emit({ type: "status", status: { kind: "suspended" } });
  }
  async setApps(apps: SessionAppSpec[]) {
    this.setAppsCalls.push(apps);
    for (const [name, slot] of this.states) {
      if (slot.state === "running") {
        this.emit({ type: "app", app: name, state: "ready", ended: { runId: slot.runId!, reason: "the app set changed" } });
      }
    }
    this.apps = apps;
  }
  async setAgent(name: string | null) {
    this.agent = name;
  }
  async runApp(app: string, request: RunAppRequest): Promise<string> {
    this.runCalls.push({ app, request });
    if (this.states.get(app)?.state !== "ready") throw new RunnerRefusal(409, "app_not_ready", `app '${app}' is not ready yet`);
    const runId = `run-${++this.runs}`;
    this.emit({ type: "app", app, state: "running", runId });
    return runId;
  }
  async stopApp(app: string) {
    this.stopCalls.push(app);
    const slot = this.states.get(app);
    if (slot?.state === "running") this.emit({ type: "app", app, state: "ready", ended: { runId: slot.runId!, signal: "SIGTERM" } });
  }
  async reload() {}
  async workspaceTree() {
    return [];
  }
  async readWorkspaceFile() {
    return "";
  }
  async applyWorkspace() {}
  subscribe(onEvent: (event: RunEvent) => void) {
    this.listeners.add(onEvent);
    return () => {
      this.listeners.delete(onEvent);
    };
  }
  io(): SequencedRunIo {
    return {
      lastSeq: () => 0,
      open: () => ({ send() {}, resize() {}, close() {} }),
    };
  }
}

/** A runner holding sessions in memory, answering as the `/v1` contract does:
 *  a create with no identity mints a resume secret, an identity's create (its
 *  credentials send `Authorization: DPoP …`) is owned by the identity, and a
 *  session is reached only by its owner. */
export class FakeRunner {
  readonly creates: CreateSessionRequest[] = [];
  readonly sessions = new Map<string, FakeSession>();
  /** Each session's owner: `identity`, or the resume secret. */
  readonly owners = new Map<string, string>();
  private minted = 0;
  capabilities: RunnerCapabilities = {
    displayName: "Fake",
    description: "",
    config: { schema: {} },
    features: { io: ["tty", "streams"], ports: true, agents: ["authoring-agent"] },
  };

  readonly connection: RunnerConnection = {
    baseUrl: "http://runner.test",
    createSession: async (request, options): Promise<CreatedSession> => {
      this.creates.push(request);
      const id = `s${++this.minted}`;
      this.sessions.set(id, new FakeSession(id, request.apps, request.agent ?? null));
      if (options.credentials && (await this.callerOf(options.credentials)) === "identity") {
        this.owners.set(id, "identity");
        return { kind: "created", sessionId: id };
      }
      const secret = `secret-${id}`;
      this.owners.set(id, `Bearer ${secret}`);
      return { kind: "created", sessionId: id, resumeSecret: secret };
    },
    listSessions: async (workspace, credentials) => {
      if ((await this.callerOf(credentials)) !== "identity") throw new RunnerRefusal(403, "identity_required", "identity only");
      return [...this.sessions.keys()]
        .filter((id) => this.owners.get(id) === "identity")
        .map((id) => ({ sessionId: id, workspace, status: this.sessions.get(id)!.status.kind, lastActiveAt: "" }));
    },
    adoptSession: async (sessionId, resumeSecret, credentials) => {
      if ((await this.callerOf(credentials)) !== "identity") throw new RunnerRefusal(403, "identity_required", "identity only");
      if (this.owners.get(sessionId) !== `Bearer ${resumeSecret}`) return { kind: "gone" };
      this.owners.set(sessionId, "identity");
      return { kind: "adopted", sessionId };
    },
    session: (sessionId, credentials) => {
      const held = this.sessions.get(sessionId);
      const runner = this;
      // Every route asks the credentials, as the http adapter does, and a
      // session another owner holds answers like one that does not exist.
      const guard = async <T>(work: (session: FakeSession) => Promise<T>): Promise<T> => {
        if (!held || (await runner.callerOf(credentials)) !== runner.owners.get(sessionId)) throw new SessionGoneError();
        return work(held);
      };
      return {
        id: sessionId,
        read: () => guard((s) => s.read()),
        resume: () => guard((s) => s.resume()),
        suspend: () => guard((s) => s.suspend()),
        setApps: (apps) => guard((s) => s.setApps(apps)),
        setAgent: (name) => guard((s) => s.setAgent(name)),
        runApp: (app, request) => guard((s) => s.runApp(app, request)),
        stopApp: (app) => guard((s) => s.stopApp(app)),
        reload: () => guard((s) => s.reload()),
        workspaceTree: () => guard((s) => s.workspaceTree()),
        readWorkspaceFile: () => guard((s) => s.readWorkspaceFile()),
        applyWorkspace: () => guard((s) => s.applyWorkspace()),
        subscribe: (onEvent) => (held ? held.subscribe(onEvent) : () => undefined),
        io: () => held!.io(),
      };
    },
  };

  readonly adapter: RunAdapter<unknown> = {
    id: "fake",
    displayName: "Fake runner",
    description: "",
    configSchema: {},
    defaultConfig: {},
    validateConfig: () => [],
    isAvailable: async () => ({ status: "ready" }),
    fetchCapabilities: async () => this.capabilities,
    connect: async () => this.connection,
  };

  /** Who a request with these credentials is: `identity`, or its bearer. */
  async callerOf(credentials: RunnerCredentials): Promise<string> {
    const { authorization = "" } = await credentials.headers({ method: "GET", url: "http://runner.test/v1/sessions" });
    return authorization.startsWith("DPoP ") ? "identity" : authorization;
  }

  /** Forget a session, as retention does. */
  drop(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/** A bridge over an empty editor workspace: seeding it writes nothing. */
export const emptyBridge: WorkspaceBridge = {
  snapshot: async () => new Map(),
  readFile: async () => "",
  readBytes: async () => new Uint8Array(),
  probeFile: async () => ({ kind: "missing" as const }),
  applyChanges: async () => undefined,
  editorFile: () => null,
  workspaceFile: () => null,
};

export function app(name: string, ports: number[] = []): SessionAppSpec {
  return { name, entryRelativePath: `${name}/telo.yaml`, ports: ports.map((port) => ({ port, protocol: "tcp" })) };
}

/** Let queued promise work settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Resume secrets held in memory, as a host's store holds them. */
export function memoryResumeSecretStore(): ResumeSecretStore {
  const held = new Map<string, string>();
  const key = (scope: ResumeSecretScope) => JSON.stringify([scope.runner, scope.workspaceKey]);
  return {
    read: async (scope) => held.get(key(scope)) ?? null,
    write: async (scope, secret) => {
      if (secret === null) held.delete(key(scope));
      else held.set(key(scope), secret);
    },
  };
}
