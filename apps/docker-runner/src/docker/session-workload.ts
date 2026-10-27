import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  agentImage,
  isGenerationMismatch,
  portKey,
  SessionStartError,
  SupervisedApp,
  STOP_GRACE_MS,
  WorkspaceClient,
  workspaceAppManifest,
  WORKSPACE_APP_FILENAME,
  workspaceMarkerWrite,
  type AdoptedWorkload,
  type AppAddresses,
  type AppRun,
  type BackendAppSpec,
  type BackendWorkload,
  type PortMapping,
  type RunnerAgent,
  type RunnerEndpoint,
  type SessionConfig,
  type SupervisorTermination,
  type WorkloadCallbacks,
  type WorkloadTokens,
  type WorkspaceAccess,
} from "@telorun/runner-core";
import { appContainerConfig, type TeloImageSource } from "@telorun/runner-core/container";

import {
  agentContainer,
  APP_LABEL,
  appContainer,
  appRole,
  inspectPortFor,
  reservedPortsFor,
  ROLE_LABEL,
  SUPERVISOR_LISTEN_ENV,
  SUPERVISOR_TOKEN_ENV,
  supervisorPortFor,
  workspaceContainer,
  WORKSPACE_PORT,
  type SessionContainerArgs,
} from "./container-spec.js";
import {
  messageOf,
  type CreateContainerOpts,
  type InspectedSessionContainer,
  type SessionDockerClient,
  type SessionDockerContainer,
  type WaitResult,
} from "./docker-api.js";
import { ensureImage } from "./image-pull.js";
import type { DeliveredSupervisor } from "./supervisor-delivery.js";

/** The workspace container is a kernel boot plus a module resolve. */
const WORKSPACE_READY_TIMEOUT_MS = 120_000;
/** A supervisor listens as soon as its container starts. */
const SUPERVISOR_CONNECT_TIMEOUT_MS = 60_000;
/** Adoption runs before the runner listens, so a supervisor that does not
 *  answer promptly fails its session rather than holding the boot. */
const ADOPT_CONNECT_TIMEOUT_MS = 10_000;
const POLL_MS = 500;

export interface DockerWorkloadDeps {
  docker: SessionDockerClient;
  /** Runner-visible path of the bundle volume. */
  bundleRoot: string;
  /** Daemon-visible name of the bundle volume. */
  bundleVolume: string;
  childNetwork: string;
  publicBaseUrl?: string;
  teloImages: TeloImageSource;
  /** The operator's kernel image, for the runner's own workspace container. */
  workspaceImage: string;
  /** The supervisor build every app container created from now on mounts. */
  supervisor: DeliveredSupervisor;
}

export interface DockerWorkloadSpec {
  sessionId: string;
  apps: BackendAppSpec[];
  /** Its `tokenEnv` already carrying this creation's token. */
  agent?: RunnerAgent;
  config: SessionConfig;
}

/** One container of the workload. */
interface Slot {
  name: string;
  container: SessionDockerContainer;
  /** Its address on the child network, where the runner reaches it. */
  ip: string;
  /** Set once the runner removes it, so its ending is no failure. */
  removing: boolean;
}

interface AppSlot extends Slot {
  supervisor: SupervisedApp;
}

interface Runtime {
  workspace: Slot;
  client: WorkspaceClient;
  agent?: Slot;
  apps: Map<string, AppSlot>;
  /** Set once this workload's failure was reported, so it is reported once. */
  failed: boolean;
}

/** What adoption found that is not a workload to take over. */
export type AdoptionOutcome =
  | { kind: "adopted"; adopted: AdoptedWorkload }
  /** The containers predate this runner build or the stored app set; remove
   *  them and suspend the session — its resume builds current ones. */
  | { kind: "stale"; reason: string };

/**
 * A session's workload on docker: sibling containers on the child network over
 * the session's own directory on the bundle volume — a `workspace` container,
 * one idle `app-<name>` container per application running the session
 * supervisor, and an optional co-resident `agent`.
 *
 * Containers, unlike a pod's, are replaced one role at a time: an app-set
 * change replaces the app containers and keeps the workspace and the agent, an
 * agent change replaces the agent and ends every live run. Either way every
 * live run ends and each app reports `ready` again.
 */
export class DockerSessionWorkload implements BackendWorkload {
  private runtime: Runtime | null = null;
  private apps: BackendAppSpec[];
  private agent: RunnerAgent | undefined;
  private readonly args: SessionContainerArgs;
  /** The bring-up in progress: an ending of one of its containers fails it. */
  private bringUpFailure: ((err: Error) => void) | undefined;
  private bringUpFailed: Promise<never> | undefined;

  readonly workspace: WorkspaceAccess = {
    tree: () => this.requireRuntime().client.tree(),
    readFile: (path) => this.requireRuntime().client.readFile(path),
    apply: (changes) => this.requireRuntime().client.apply(changes),
  };

  private constructor(
    private readonly deps: DockerWorkloadDeps,
    private readonly spec: DockerWorkloadSpec,
    private readonly callbacks: WorkloadCallbacks,
  ) {
    this.apps = spec.apps.map(copyApp);
    this.agent = spec.agent;
    this.args = {
      sessionId: spec.sessionId,
      bundleVolume: deps.bundleVolume,
      childNetwork: deps.childNetwork,
      publicBaseUrl: deps.publicBaseUrl,
    };
  }

  /** Create the session's containers over its storage. Resolves once every
   *  app's supervisor answered, after `running` and each app's `ready`. */
  static async create(
    deps: DockerWorkloadDeps,
    spec: DockerWorkloadSpec,
    callbacks: WorkloadCallbacks,
  ): Promise<DockerSessionWorkload> {
    const workload = new DockerSessionWorkload(deps, spec, callbacks);
    await workload.bringUp();
    return workload;
  }

  /** Take over the running containers a previous runner process left: one
   *  inspected container per role, every one of them running. */
  static async adopt(
    deps: DockerWorkloadDeps,
    spec: DockerWorkloadSpec,
    callbacks: WorkloadCallbacks,
    found: InspectedSessionContainer[],
  ): Promise<AdoptionOutcome> {
    const read = readAdoptable(found, spec, deps.childNetwork, deps.workspaceImage);
    if ("stale" in read) return { kind: "stale", reason: read.stale };
    const agent = withAgentToken(spec.agent, read.agentToken);
    const workload = new DockerSessionWorkload(deps, { ...spec, agent }, callbacks);
    const slot = (c: InspectedSessionContainer): Slot => ({
      name: containerNameOf(c),
      container: deps.docker.getContainer(c.Id),
      ip: c.NetworkSettings!.Networks![deps.childNetwork]!.IPAddress!,
      removing: false,
    });
    const workspace = slot(read.workspace);
    const rt: Runtime = {
      workspace,
      client: new WorkspaceClient(`http://${workspace.ip}:${WORKSPACE_PORT}`),
      ...(read.agent ? { agent: slot(read.agent) } : {}),
      apps: new Map(),
      failed: false,
    };
    try {
      await workload.connectApps(
        rt,
        workload.apps.map((app) => ({ app, slot: slot(read.apps.get(app.name)!), token: read.tokens[app.name]! })),
        ADOPT_CONNECT_TIMEOUT_MS,
      );
    } catch (err) {
      await closeSupervisors(rt);
      if (isGenerationMismatch(err)) {
        return { kind: "stale", reason: "its session supervisors speak another protocol generation" };
      }
      throw err;
    }
    workload.runtime = rt;
    workload.watchAll(rt);
    workload.reportRunning(rt);
    return {
      kind: "adopted",
      adopted: { workload, tokens: read.agentToken !== undefined ? { agent: read.agentToken } : {} },
    };
  }

  // ---- BackendWorkload -------------------------------------------------------

  async addresses(app: string): Promise<AppAddresses> {
    const slot = this.appSlot(app);
    const port = inspectPortFor(this.indexOf(app));
    return { inspect: { listen: `0.0.0.0:${port}`, url: `http://${slot.ip}:${port}/events` }, host: slot.ip };
  }

  runApp(app: string, run: AppRun): Promise<void> {
    return this.appSlot(app).supervisor.run(run);
  }

  stopApp(app: string, runId: string, graceMs: number): Promise<void> {
    return this.appSlot(app).supervisor.stop(runId, graceMs);
  }

  writeStdin(app: string, runId: string, bytes: Uint8Array): void {
    this.runtime?.apps.get(app)?.supervisor.writeStdin(runId, bytes);
  }

  resize(app: string, runId: string, cols: number, rows: number): void {
    this.runtime?.apps.get(app)?.supervisor.resize(runId, cols, rows);
  }

  async reload(app: string): Promise<void> {
    const entry = this.apps[this.indexOf(app)]!.entryRelativePath;
    await this.requireRuntime().client.touch(entry);
  }

  /**
   * Re-route an app whose declared port set changed on reload. Behind a proxy
   * nothing has to change — it reaches the container by name on any port — so
   * a new port is routable once something binds it. Published to the host,
   * port bindings are fixed at container creation, so a new port is reported
   * as unroutable rather than left silently unreachable.
   */
  applyDeclaredPorts(appName: string, declared: PortMapping[]): void {
    const app = this.apps.find((a) => a.name === appName);
    if (!app) return;
    const before = new Map(app.ports.map((p) => [portKey(p), p]));
    const after = new Map(declared.map((p) => [portKey(p), p]));
    const added = declared.filter((p) => !before.has(portKey(p)));
    const removed = app.ports.filter((p) => !after.has(portKey(p)));
    if (added.length === 0 && removed.length === 0) {
      app.ports = app.ports.map((p) => after.get(portKey(p)) ?? p);
      return;
    }

    const taken = new Map<string, string>();
    for (const other of this.apps) {
      if (other.name === appName) continue;
      for (const p of other.ports) {
        taken.set(portKey(p), `another app in this session already declares ${p.protocol} port ${p.port}`);
      }
    }
    if (this.agent?.port !== undefined) {
      taken.set(
        portKey({ port: this.agent.port, protocol: "tcp" }),
        `this session's co-resident agent '${this.agent.name}' listens on tcp port ${this.agent.port}`,
      );
    }
    for (const r of reservedPortsFor(this.apps)) {
      taken.set(portKey(r), `this runner reserves ${r.protocol} port ${r.port} for ${r.purpose} of app '${r.app}'`);
    }
    if (!this.deps.publicBaseUrl) {
      for (const p of added) {
        if (taken.has(portKey(p))) continue;
        taken.set(
          portKey(p),
          "this runner publishes session ports to the host, and a container's port bindings are fixed " +
            "at creation — change the app set or resume the session to reach this port",
        );
      }
    }
    const rejected = added.filter((p) => taken.has(portKey(p)));
    const accepted = added.filter((p) => !taken.has(portKey(p)));
    app.ports = [...app.ports.filter((p) => after.has(portKey(p))).map((p) => after.get(portKey(p))!), ...accepted];

    this.callbacks.onEndpoints(appName, {
      ...(accepted.length > 0 ? { added: this.endpointsFor(accepted) } : {}),
      ...(removed.length > 0 ? { removed: this.endpointsFor(removed) } : {}),
      ...(rejected.length > 0 ? { rejected: rejected.map((p) => ({ port: p.port, reason: taken.get(portKey(p))! })) } : {}),
    });
  }

  async setApps(next: BackendAppSpec[]): Promise<void> {
    const rt = this.requireRuntime();
    if (sameStructure(this.apps, next)) {
      // Nothing the containers are built from changed: the slots stay, and only
      // the live runs end, as an app-set change always ends them.
      this.apps = next.map(copyApp);
      await this.endLiveRuns(rt);
      return;
    }
    // Every image of the new set first: a pull that fails leaves the running
    // containers as they were.
    await this.pullAppImages(next);
    await this.removeApps(rt);
    this.apps = next.map(copyApp);
    await this.startApps(rt, SUPERVISOR_CONNECT_TIMEOUT_MS);
    this.reportRunning(rt);
  }

  async setAgent(agent: RunnerAgent | undefined, tokens: WorkloadTokens): Promise<void> {
    const rt = this.requireRuntime();
    if (agent) await ensureImage(this.deps.docker, agentImage(agent, this.deps.workspaceImage), agent.pullPolicy);
    await this.endLiveRuns(rt, { report: false });
    if (rt.agent) await removeSlot(rt.agent);
    rt.agent = undefined;
    this.agent = agent;
    if (agent) {
      rt.agent = await this.startContainer(agentContainer(this.args, agent, this.deps.workspaceImage));
      this.watch(rt, rt.agent);
    }
    this.reportRunning(rt);
  }

  async suspend(): Promise<void> {
    const rt = this.runtime;
    this.runtime = null;
    if (!rt) return;
    await closeSupervisors(rt);
    await Promise.all(slotsOf(rt).map(removeSlot));
  }

  async detach(): Promise<void> {
    const rt = this.runtime;
    this.runtime = null;
    if (!rt) return;
    for (const slot of slotsOf(rt)) slot.removing = true;
    await closeSupervisors(rt);
  }

  // ---- Bring-up ---------------------------------------------------------------

  private async bringUp(): Promise<void> {
    const { docker, teloImages, workspaceImage } = this.deps;
    await this.prepareStorage();
    await ensureImage(docker, workspaceImage, teloImages.pullPolicy);
    await this.pullAppImages(this.apps);
    if (this.agent) await ensureImage(docker, agentImage(this.agent, workspaceImage), this.agent.pullPolicy);

    const started: Slot[] = [];
    this.bringUpFailed = new Promise<never>((_, reject) => {
      this.bringUpFailure = reject;
    });
    // Observed by every step it is raced with; never left unhandled.
    this.bringUpFailed.catch(() => {});
    let rt: Runtime | undefined;
    try {
      this.callbacks.onProgress("boot", "Starting workspace");
      const workspace = await this.startContainer(workspaceContainer(this.args, workspaceImage));
      started.push(workspace);
      rt = {
        workspace,
        client: new WorkspaceClient(`http://${workspace.ip}:${WORKSPACE_PORT}`),
        apps: new Map(),
        failed: false,
      };
      this.watch(rt, workspace);
      await this.failFast(waitForWorkspace(rt.client));
      const seed = workspaceMarkerWrite(await rt.client.tree());
      if (seed.length > 0) await rt.client.apply({ write: seed });

      this.callbacks.onProgress("boot", "Starting application containers");
      await this.startApps(rt, SUPERVISOR_CONNECT_TIMEOUT_MS);
      if (this.agent) {
        rt.agent = await this.startContainer(agentContainer(this.args, this.agent, workspaceImage));
        started.push(rt.agent);
        this.watch(rt, rt.agent);
      }
    } catch (err) {
      // Nothing of a workload that never came up is left behind; the storage stays.
      if (rt) await closeSupervisors(rt);
      await Promise.all(started.map(removeSlot)).catch((cleanup) => {
        throw new Error(`${messageOf(err)}; and removing its containers failed: ${messageOf(cleanup)}`, {
          cause: cleanup,
        });
      });
      if (err instanceof SessionStartError) throw err;
      throw new SessionStartError("start_failed", "start", `the session's containers did not come up: ${messageOf(err)}`, messageOf(err));
    } finally {
      this.bringUpFailure = undefined;
      this.bringUpFailed = undefined;
    }

    this.runtime = rt;
    this.reportRunning(rt);
  }

  /** The session's directory on the bundle volume: `workspace/` and `agent/`
   *  (both mounted by `Subpath`, which needs them to exist), the workspace
   *  application's manifest and its cache. Kept across suspend. */
  private async prepareStorage(): Promise<void> {
    const root = join(this.deps.bundleRoot, this.spec.sessionId);
    for (const dir of ["workspace", "agent", "workspace-app", "cache"]) {
      await mkdir(join(root, dir), { recursive: true });
    }
    await writeFile(join(root, "workspace-app", WORKSPACE_APP_FILENAME), workspaceAppManifest(), "utf8");
  }

  private async pullAppImages(apps: BackendAppSpec[]): Promise<void> {
    for (const app of apps) {
      const image = appContainerConfig(this.spec.config, app.telo, this.deps.teloImages);
      if (app.telo !== undefined) this.callbacks.onProgress("provision", `Pulling telo ${app.telo}`, undefined, app.name);
      await ensureImage(this.deps.docker, image.image, image.pullPolicy);
    }
  }

  private async startContainer(opts: CreateContainerOpts): Promise<Slot> {
    let container: SessionDockerContainer;
    try {
      container = await this.deps.docker.createContainer(opts);
    } catch (err) {
      throw new SessionStartError("start_failed", "create", `could not create container '${opts.name}'`, messageOf(err));
    }
    const slot: Slot = { name: opts.name, container, ip: "", removing: false };
    try {
      await container.start();
      const ip = (await container.inspect()).NetworkSettings?.Networks?.[this.deps.childNetwork]?.IPAddress;
      if (!ip) throw new Error(`it has no address on network '${this.deps.childNetwork}'`);
      slot.ip = ip;
    } catch (err) {
      await removeSlot(slot);
      throw new SessionStartError("start_failed", "start", `could not start container '${opts.name}'`, messageOf(err));
    }
    return slot;
  }

  /** One container per app, each with a token of its own and watched from
   *  its start, and its supervisor connected. What fails leaves none of them. */
  private async startApps(rt: Runtime, timeoutMs: number): Promise<void> {
    const declaring = this.apps.filter((a) => a.ports.length > 0);
    const aliasOwner = declaring.length === 1 ? declaring[0]!.name : undefined;
    if (declaring.length > 1 && this.deps.publicBaseUrl) {
      // Docker round-robins a shared alias, so with several port-declaring apps
      // the session's name would reach a random one of them: nothing takes it,
      // and every such port is reported unroutable.
      for (const app of declaring) {
        this.callbacks.onEndpoints(app.name, {
          rejected: app.ports.map((p) => ({
            port: p.port,
            reason:
              "this runner fronts sessions with a proxy that resolves one name per session " +
              `(telo-run-<sessionId>), and ${declaring.length} apps in this session declare ports`,
          })),
        });
      }
    }
    const planned: Array<{ app: BackendAppSpec; slot: Slot; token: string }> = [];
    try {
      for (const [index, app] of this.apps.entries()) {
        const token = randomBytes(32).toString("base64url");
        const slot = await this.startContainer(
          appContainer(this.args, {
            app,
            index,
            image: appContainerConfig(this.spec.config, app.telo, this.deps.teloImages).image,
            token,
            supervisor: this.deps.supervisor,
            ownsSessionAlias: app.name === aliasOwner,
          }),
        );
        planned.push({ app, slot, token });
        this.watch(rt, slot);
      }
      await this.connectApps(rt, planned, timeoutMs);
    } catch (err) {
      await closeSupervisors(rt);
      rt.apps = new Map();
      await Promise.all(planned.map(({ slot }) => removeSlot(slot)));
      throw err;
    }
  }

  private async connectApps(
    rt: Runtime,
    planned: Array<{ app: BackendAppSpec; slot: Slot; token: string }>,
    timeoutMs: number,
  ): Promise<void> {
    for (const { app, slot, token } of planned) {
      const index = this.indexOf(app.name);
      const appSlot: AppSlot = Object.assign(slot, {
        supervisor: new SupervisedApp(
          { host: slot.ip, port: supervisorPortFor(index), token, label: `container '${slot.name}'` },
          {
            onAppState: (state) => {
              if (this.current(rt, app.name, appSlot)) this.callbacks.onAppState(app.name, state);
            },
            onOutput: (chunk, stream) => {
              if (this.current(rt, app.name, appSlot)) this.callbacks.onOutput(app.name, chunk, stream);
            },
            onTerminated: (termination) => {
              if (this.current(rt, app.name, appSlot)) this.supervisorEnded(rt, slot.name, termination);
            },
          },
        ),
      });
      rt.apps.set(app.name, appSlot);
    }
    await this.failFast(Promise.all([...rt.apps.values()].map((s) => s.supervisor.connect(timeoutMs))));
  }

  /** A step of a bring-up, cut short when one of its containers ends. */
  private failFast<T>(step: Promise<T>): Promise<T> {
    return this.bringUpFailed ? Promise.race([step, this.bringUpFailed]) : step;
  }

  /** `running` with the endpoints, then each app's state as it stands. */
  private reportRunning(rt: Runtime): void {
    const agent = this.agentEndpoint();
    this.callbacks.onStatus({
      kind: "running",
      endpoints: this.endpointsFor(this.apps.flatMap((a) => a.ports)),
      ...(agent ? { agent } : {}),
    });
    for (const slot of rt.apps.values()) slot.supervisor.report();
  }

  private async endLiveRuns(rt: Runtime, options: { report: boolean } = { report: true }): Promise<void> {
    for (const [app, slot] of rt.apps) {
      const live = slot.supervisor.liveRunId;
      if (live !== undefined) await slot.supervisor.stop(live, STOP_GRACE_MS);
      else if (options.report) this.callbacks.onAppState(app, { state: "ready" });
    }
  }

  private async removeApps(rt: Runtime): Promise<void> {
    const slots = [...rt.apps.values()];
    rt.apps = new Map();
    await Promise.all(slots.map((s) => s.supervisor.close()));
    await Promise.all(slots.map(removeSlot));
  }

  // ---- Failure ----------------------------------------------------------------

  private current(rt: Runtime, app: string, slot: AppSlot): boolean {
    return this.runtime === rt && rt.apps.get(app) === slot;
  }

  private watchAll(rt: Runtime): void {
    for (const slot of slotsOf(rt)) this.watch(rt, slot);
  }

  /** A container that ends is the session's infrastructure failure, never a
   *  run's: its main process is the workspace, the agent, or a supervisor. */
  private watch(rt: Runtime, slot: Slot): void {
    slot.container.wait().then(
      (result) => {
        if (slot.removing) return;
        this.failure(rt, `container '${slot.name}' ended (${describeWait(result)})`);
      },
      (err) => {
        if (slot.removing) return;
        this.failure(rt, `the runner lost track of container '${slot.name}': ${messageOf(err)}`);
      },
    );
  }

  private failure(rt: Runtime, message: string): void {
    if (this.runtime !== rt) {
      this.bringUpFailure?.(new Error(message));
      return;
    }
    if (rt.failed) return;
    rt.failed = true;
    this.callbacks.onStatus({ kind: "failed", message });
  }

  private supervisorEnded(rt: Runtime, container: string, termination: SupervisorTermination): void {
    this.failure(
      rt,
      termination.kind === "generation_mismatch"
        ? `container '${container}' runs a session supervisor of another protocol generation; ` +
            `resume the session to recreate its containers`
        : `the session supervisor of container '${container}' can no longer be reached ` +
            `(${termination.kind}): ${termination.message}`,
    );
  }

  // ---- Endpoints ----------------------------------------------------------------

  /** Without a proxy `host` is left blank — the runner does not know the
   *  hostname clients reached it by, and the client fills it in. With one, each
   *  tcp port gets the proxy's `<port>-<sessionId>` URL. */
  private endpointsFor(ports: PortMapping[]): RunnerEndpoint[] {
    const base = this.deps.publicBaseUrl ? new URL(this.deps.publicBaseUrl) : null;
    const id = this.spec.sessionId;
    return ports.map((p) => {
      if (!base || p.protocol !== "tcp") return { host: "", port: p.port, protocol: p.protocol };
      return { host: `${id}.${base.hostname}`, port: p.port, protocol: p.protocol, url: `${base.protocol}//${p.port}-${id}.${base.host}` };
    });
  }

  /** The agent's own alias is the proxy's trailing capture, so
   *  `<port>-<sessionId>-agent.<domain>` reaches it under the existing rule. */
  private agentEndpoint(): RunnerEndpoint | undefined {
    const port = this.agent?.port;
    if (port === undefined) return undefined;
    if (!this.deps.publicBaseUrl) return { host: "", port, protocol: "tcp" };
    const base = new URL(this.deps.publicBaseUrl);
    const id = this.spec.sessionId;
    return {
      host: `${port}-${id}-agent.${base.hostname}`,
      port,
      protocol: "tcp",
      url: `${base.protocol}//${port}-${id}-agent.${base.host}`,
    };
  }

  // ---- Lookups ----------------------------------------------------------------

  private requireRuntime(): Runtime {
    if (!this.runtime) throw new Error("the session's containers are being replaced");
    return this.runtime;
  }

  private indexOf(app: string): number {
    const index = this.apps.findIndex((a) => a.name === app);
    if (index < 0) throw new Error(`the session runs no app named '${app}'`);
    return index;
  }

  private appSlot(app: string): AppSlot {
    const slot = this.requireRuntime().apps.get(app);
    if (!slot) throw new Error(`the session runs no app named '${app}'`);
    return slot;
  }
}

/** What an adopting runner reads back from the inspected containers, or why
 *  they are not the ones the stored session describes. */
function readAdoptable(
  found: InspectedSessionContainer[],
  spec: DockerWorkloadSpec,
  network: string,
  kernelImage: string,
):
  | {
      workspace: InspectedSessionContainer;
      agent: InspectedSessionContainer | undefined;
      apps: Map<string, InspectedSessionContainer>;
      tokens: Record<string, string>;
      agentToken: string | undefined;
    }
  | { stale: string } {
  const role = (c: InspectedSessionContainer) => c.Config?.Labels?.[ROLE_LABEL];
  const workspaces = found.filter((c) => role(c) === "workspace");
  const agents = found.filter((c) => role(c) === "agent");
  const apps = new Map(found.filter((c) => role(c) === "app").map((c) => [c.Config?.Labels?.[APP_LABEL] ?? "", c]));
  if (workspaces.length !== 1) return { stale: "it has no single workspace container" };
  const appNames = [...apps.keys()].sort().join(",");
  if (appNames !== spec.apps.map((a) => a.name).sort().join(",") || apps.size !== found.filter((c) => role(c) === "app").length) {
    return { stale: "its app containers are not the stored app set" };
  }
  if (agents.length > 1 || Boolean(agents[0]) !== Boolean(spec.agent) || (spec.agent && agents[0]!.Config?.Image !== agentImage(spec.agent, kernelImage))) {
    return { stale: "its agent is not the stored agent" };
  }
  for (const c of found) {
    if (!c.NetworkSettings?.Networks?.[network]?.IPAddress) {
      return { stale: `container '${containerNameOf(c)}' has no address on network '${network}'` };
    }
  }
  const tokens: Record<string, string> = {};
  for (const [index, app] of spec.apps.entries()) {
    const env = envOf(apps.get(app.name)!);
    const token = env[SUPERVISOR_TOKEN_ENV];
    if (!token || env[SUPERVISOR_LISTEN_ENV] !== `0.0.0.0:${supervisorPortFor(index)}`) {
      return { stale: `container '${appRole(app.name)}' runs no session supervisor this runner can reach` };
    }
    tokens[app.name] = token;
  }
  let agentToken: string | undefined;
  if (spec.agent?.tokenEnv !== undefined) {
    agentToken = envOf(agents[0]!)[spec.agent.tokenEnv];
    if (!agentToken) return { stale: `its agent carries no ${spec.agent.tokenEnv}` };
  }
  return { workspace: workspaces[0]!, agent: agents[0], apps, tokens, agentToken };
}

/** Why a container stopped, as the daemon recorded it. */
export function describeEnding(c: InspectedSessionContainer): string {
  const state = c.State ?? {};
  const parts = [
    ...(state.OOMKilled ? ["OOMKilled"] : []),
    `exit code ${state.ExitCode ?? "unknown"}`,
    ...(state.Error ? [state.Error] : []),
  ];
  return parts.join(", ");
}

function describeWait(result: WaitResult): string {
  return [`exit code ${result.StatusCode}`, ...(result.Error?.Message ? [result.Error.Message] : [])].join(", ");
}

export function containerNameOf(c: { Id: string; Name?: string }): string {
  return c.Name ? c.Name.replace(/^\//, "") : c.Id;
}

function envOf(c: InspectedSessionContainer): Record<string, string> {
  return Object.fromEntries(
    (c.Config?.Env ?? []).map((entry) => {
      const at = entry.indexOf("=");
      return at < 0 ? [entry, ""] : [entry.slice(0, at), entry.slice(at + 1)];
    }),
  );
}

function withAgentToken(agent: RunnerAgent | undefined, token: string | undefined): RunnerAgent | undefined {
  if (!agent || agent.tokenEnv === undefined || token === undefined) return agent;
  return { ...agent, env: { ...agent.env, [agent.tokenEnv]: token } };
}

/** Whether two app sets build the same containers: the same apps in the same
 *  order (ports are assigned by position), on the same telo, declaring the same
 *  ports. */
function sameStructure(current: BackendAppSpec[], next: BackendAppSpec[]): boolean {
  if (current.length !== next.length) return false;
  return current.every((app, i) => {
    const other = next[i]!;
    const ports = (a: BackendAppSpec) => a.ports.map(portKey).sort().join(",");
    return app.name === other.name && app.telo === other.telo && ports(app) === ports(other);
  });
}

function copyApp(app: BackendAppSpec): BackendAppSpec {
  return { ...app, ports: app.ports.map((p) => ({ ...p })) };
}

function slotsOf(rt: Runtime): Slot[] {
  return [rt.workspace, ...rt.apps.values(), ...(rt.agent ? [rt.agent] : [])];
}

async function closeSupervisors(rt: Runtime): Promise<void> {
  await Promise.all([...rt.apps.values()].map((s) => s.supervisor.close()));
}

async function removeSlot(slot: Slot): Promise<void> {
  slot.removing = true;
  await removeContainer(slot.container);
}

/** Remove a container and its anonymous volumes; one already gone is done. */
export async function removeContainer(container: Pick<SessionDockerContainer, "remove">): Promise<void> {
  try {
    await container.remove({ force: true, v: true });
  } catch (err) {
    const status = (err as { statusCode?: unknown } | null)?.statusCode;
    // 404: already gone. 409: a removal already in progress.
    if (status === 404 || status === 409) return;
    throw err;
  }
}

async function waitForWorkspace(client: WorkspaceClient): Promise<void> {
  const deadline = Date.now() + WORKSPACE_READY_TIMEOUT_MS;
  let last = "no response";
  for (;;) {
    try {
      await client.tree();
      return;
    } catch (err) {
      last = messageOf(err);
    }
    if (Date.now() > deadline) {
      throw new SessionStartError("start_failed", "start", `workspace container did not become ready: ${last}`, last);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS).unref?.());
  }
}
