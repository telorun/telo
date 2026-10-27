import { randomBytes } from "node:crypto";

import type { V1Pod } from "@kubernetes/client-node";
import {
  agentImage,
  isGenerationMismatch,
  portKey,
  SessionStartError,
  SupervisedApp,
  STOP_GRACE_MS,
  WorkspaceClient,
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

import type { K8sRunnerConfig } from "../config.js";
import { clampLimits } from "../limits.js";
import { apiFailure, apiReason, withCause } from "./api-error.js";
import type { KubeClient } from "./client.js";
import {
  APP_SLOTS,
  APP_SLOTS_ANNOTATION,
  APPS_CONTAINER,
  buildSessionPod,
  inspectPortFor,
  reservedPortsFor,
  SUPERVISOR_LISTEN_ENV,
  SUPERVISOR_TOKEN_ENV,
  supervisorPortFor,
  TOOLING_SLOT,
  WORKSPACE_PORT,
} from "./pod-spec.js";
import {
  deletePodAndWait,
  keepPod,
  endedContainer,
  is404,
  msg,
  podFailureMessage,
  podPhase,
  podStatus,
  provisionMessage,
} from "./pod-status.js";
import {
  buildSessionService,
  createOrReplace,
  endpointsFor,
  hostForPort,
  publicUrlTemplateEnv,
  sessionObjectName,
  watchRouteHealth,
  type PublishedRoute,
  type SessionRouter,
} from "./routing/index.js";
import { ensureSessionVolume } from "./session-volume.js";
import { TeloReleaseFetcher } from "./telo-release.js";
import { ensureWorkspaceConfigMap } from "./workspace-configmap.js";

/** How long the pod may take to reach Running. `activeDeadlineSeconds` only
 *  bounds an already-running pod. */
const START_DEADLINE_MS = 180_000;
/** The workspace container is a kernel boot plus a module resolve, so being
 *  Running is not being ready. */
const WORKSPACE_READY_TIMEOUT_MS = 120_000;
/** A supervisor listens as soon as its container starts. */
const SUPERVISOR_CONNECT_TIMEOUT_MS = 60_000;
/** Adoption runs before the runner listens, so a supervisor that does not answer
 *  promptly fails its session rather than holding the boot. */
const ADOPT_CONNECT_TIMEOUT_MS = 10_000;
const POLL_MS = 500;
const WATCH_REARM_DELAY_MS = 2_000;

export interface SessionWorkloadDeps {
  kube: KubeClient;
  config: K8sRunnerConfig;
  /** Resolved at boot; absent → logs-only. */
  router?: SessionRouter;
}

export interface SessionWorkloadSpec {
  sessionId: string;
  apps: BackendAppSpec[];
  /** Its `tokenEnv` already carrying this creation's token. */
  agent?: RunnerAgent;
  config: SessionConfig;
}

/** Everything tied to ONE pod. Only an agent change replaces it: the apps
 *  container holds every app, so the app set never changes the pod. */
interface PodRuntime {
  name: string;
  uid: string;
  ip: string;
  workspace: WorkspaceClient;
  /** The token every supervisor slot of the apps container accepts. */
  token: string;
  supervisors: Map<string, SupervisedApp>;
  fetcher: TeloReleaseFetcher;
  abort: AbortController;
  stopWatch: () => void;
  routeAbort?: AbortController;
  /** Set once this pod's failure was reported, so it is reported once. */
  failed: boolean;
}

/** What adoption found that is not a workload to take over. */
export type AdoptionOutcome =
  | { kind: "adopted"; adopted: AdoptedWorkload }
  /** The pod predates this runner build or the stored app set; remove it and
   *  suspend the session — its resume builds a current one. */
  | { kind: "stale"; reason: string };

/**
 * A session's workload on Kubernetes: one pod over the session's own volume,
 * its one `apps` container running a session supervisor per app slot, which this
 * drives over the supervisor protocol. Adding or removing an app takes or frees
 * a slot and leaves the pod — and the workspace and agent in it — running.
 */
export class KubernetesSessionWorkload implements BackendWorkload {
  private runtime: PodRuntime | null = null;
  private apps: BackendAppSpec[];
  /** The slot each app holds in the apps container. */
  private slots: Record<string, number> = {};
  private agent: RunnerAgent | undefined;

  readonly workspace: WorkspaceAccess = {
    tree: () => this.currentWorkspace().tree(),
    readFile: (path) => this.currentWorkspace().readFile(path),
    apply: (changes) => this.currentWorkspace().apply(changes),
  };

  private constructor(
    private readonly deps: SessionWorkloadDeps,
    private readonly spec: SessionWorkloadSpec,
    private readonly callbacks: WorkloadCallbacks,
  ) {
    this.apps = spec.apps.map(copyApp);
    this.agent = spec.agent;
  }

  /** Create the session's pod over its storage. Resolves once every app's
   *  supervisor answered, after `running` and each app's `ready`. */
  static async create(
    deps: SessionWorkloadDeps,
    spec: SessionWorkloadSpec,
    callbacks: WorkloadCallbacks,
  ): Promise<KubernetesSessionWorkload> {
    const workload = new KubernetesSessionWorkload(deps, spec, callbacks);
    await workload.bringUp();
    return workload;
  }

  /** Take over a running pod a previous runner process left. */
  static async adopt(
    deps: SessionWorkloadDeps,
    spec: SessionWorkloadSpec,
    callbacks: WorkloadCallbacks,
    pod: V1Pod,
  ): Promise<AdoptionOutcome> {
    const read = readAdoptable(pod, spec, deps.config.defaultImage);
    if ("stale" in read) return { kind: "stale", reason: read.stale };
    const agent = withAgentToken(spec.agent, read.agentToken);
    const workload = new KubernetesSessionWorkload(deps, { ...spec, agent }, callbacks);
    workload.slots = read.slots;
    const rt = workload.newRuntime(pod.metadata!.name!, pod.metadata!.uid ?? "", read.ip, read.supervisorToken);
    try {
      await workload.connectSupervisors(rt, ADOPT_CONNECT_TIMEOUT_MS);
    } catch (err) {
      await closeSupervisors(rt);
      if (isGenerationMismatch(err)) {
        return { kind: "stale", reason: "its session supervisors speak another protocol generation" };
      }
      throw err;
    }
    workload.runtime = rt;
    workload.armPodWatch(rt);
    await workload.publishOrReport(rt);
    workload.reportRunning(rt);
    return {
      kind: "adopted",
      adopted: { workload, tokens: read.agentToken !== undefined ? { agent: read.agentToken } : {} },
    };
  }

  // ---- BackendWorkload -------------------------------------------------------

  async addresses(app: string): Promise<AppAddresses> {
    const rt = this.requireRuntime();
    const port = inspectPortFor(this.slotOf(app));
    return {
      inspect: { listen: `0.0.0.0:${port}`, url: `http://${rt.ip}:${port}/events` },
      host: rt.ip,
    };
  }

  /** An app naming a telo version runs that release's binary, fetched into the
   *  container on first use; one naming none runs the image's own `telo`. */
  async runApp(app: string, run: AppRun): Promise<void> {
    const supervisor = this.supervisorOf(app);
    const version = this.apps[this.indexOf(app)]!.telo;
    if (version === undefined) return supervisor.run(run);
    const rt = this.requireRuntime();
    this.callbacks.onProgress("boot", `Preparing telo ${version}`, false, app);
    const binary = await rt.fetcher.ensure(version);
    this.callbacks.onProgress("boot", `Preparing telo ${version}`, true, app);
    return supervisor.run({ ...run, argv: [binary, ...run.argv.slice(1)] });
  }

  stopApp(app: string, runId: string, graceMs: number): Promise<void> {
    return this.supervisorOf(app).stop(runId, graceMs);
  }

  writeStdin(app: string, runId: string, bytes: Uint8Array): void {
    this.runtime?.supervisors.get(app)?.writeStdin(runId, bytes);
  }

  resize(app: string, runId: string, cols: number, rows: number): void {
    this.runtime?.supervisors.get(app)?.resize(runId, cols, rows);
  }

  async reload(app: string): Promise<void> {
    const entry = this.apps[this.indexOf(app)]!.entryRelativePath;
    await this.currentWorkspace().touch(entry);
  }

  /**
   * Re-route an app whose declared port set changed on reload. A pod's
   * `containerPort` list is documentation; the Service and the routing objects
   * are what make a port reachable, so this needs no pod recreate.
   */
  applyDeclaredPorts(appName: string, declared: PortMapping[]): void {
    void this.rerouteApp(appName, declared);
  }

  /**
   * Take and free slots for the new app set. The pod is untouched: the live runs
   * end, as an app-set change always ends them, and every app's slot reports
   * ready again.
   */
  async setApps(next: BackendAppSpec[]): Promise<void> {
    const rt = this.requireRuntime();
    const kept = new Set(next.map((a) => a.name));
    for (const [app, supervisor] of rt.supervisors) {
      const live = supervisor.liveRunId;
      if (live !== undefined) await supervisor.stop(live, STOP_GRACE_MS);
      if (!kept.has(app)) {
        rt.supervisors.delete(app);
        await supervisor.close();
      }
    }
    this.apps = next.map(copyApp);
    this.slots = assignSlots(this.slots, this.apps);
    const added = this.apps.filter((a) => !rt.supervisors.has(a.name)).map((a) => this.addSupervisor(rt, a.name));
    await Promise.all(added.map((s) => s.connect(SUPERVISOR_CONNECT_TIMEOUT_MS)));
    await this.recordSlots(rt);
    await this.publishOrReport(rt);
    this.reportRunning(rt);
  }

  async setAgent(agent: RunnerAgent | undefined, tokens: WorkloadTokens): Promise<void> {
    await this.teardown();
    this.agent = agent;
    await this.bringUp();
  }

  async suspend(): Promise<void> {
    await this.teardown();
  }

  async detach(): Promise<void> {
    const rt = this.runtime;
    this.runtime = null;
    if (!rt) return;
    stopWatchers(rt);
    await closeSupervisors(rt);
  }

  // ---- The pod ----------------------------------------------------------------

  private async bringUp(): Promise<void> {
    const { kube, config } = this.deps;
    const ns = config.sessionNamespace;
    const claimName = await ensureSessionVolume(kube, config, this.spec.sessionId);
    let workspaceAppConfigMap: string;
    try {
      workspaceAppConfigMap = await ensureWorkspaceConfigMap(kube, config);
    } catch (err) {
      throw apiFailure(err, "create", "could not write the workspace application's ConfigMap");
    }
    this.slots = assignSlots({}, this.apps);
    const token = randomBytes(32).toString("base64url");
    const pod = buildSessionPod({
      config,
      sessionId: this.spec.sessionId,
      podName: freshPodName(this.spec.sessionId),
      appSlots: this.slots,
      supervisorToken: token,
      agent: this.agent,
      sessionConfig: this.spec.config,
      claimName,
      workspaceAppConfigMap,
      hostEnv: this.deps.router ? publicUrlTemplateEnv(config, this.spec.sessionId) : {},
      limits: { app: clampLimits(config.limits, undefined), agent: clampLimits(config.appLimits, undefined) },
    });
    const name = pod.metadata!.name!;

    let created: V1Pod;
    try {
      created = await kube.core.createNamespacedPod({ namespace: ns, body: pod });
    } catch (err) {
      throw apiFailure(err, "create", "could not create the session pod");
    }

    let rt: PodRuntime | undefined;
    try {
      const ip = await this.waitForRunning(name);
      rt = this.newRuntime(name, created.metadata?.uid ?? "", ip, token);
      await this.waitForWorkspace(rt.workspace);
      const seed = workspaceMarkerWrite(await rt.workspace.tree());
      if (seed.length > 0) await rt.workspace.apply({ write: seed });
      this.callbacks.onProgress("boot", "Starting application containers");
      await this.connectSupervisors(rt, SUPERVISOR_CONNECT_TIMEOUT_MS);
    } catch (err) {
      // Nothing of a pod that never came up is left behind (unless the operator
      // asked to keep it for inspection); the storage stays.
      if (rt) await closeSupervisors(rt);
      const gone = config.keepFailedPods ? keepPod(kube, ns, name) : deletePodAndWait(kube, ns, name);
      await gone.catch((cleanup) => {
        throw withCause(new Error(`${msg(err)}; and removing the pod failed: ${msg(cleanup)}`), cleanup);
      });
      if (err instanceof SessionStartError) throw err;
      throw withCause(
        new SessionStartError(
          "start_failed",
          "start",
          `the session pod did not come up: ${msg(err)}` + (config.keepFailedPods ? ` (pod '${name}' kept)` : ""),
        ),
        (err as { cause?: unknown })?.cause ?? err,
      );
    }

    this.runtime = rt;
    this.armPodWatch(rt);
    await this.publishOrReport(rt);
    this.reportRunning(rt);
  }

  private newRuntime(name: string, uid: string, ip: string, token: string): PodRuntime {
    return {
      name,
      uid,
      ip,
      token,
      workspace: new WorkspaceClient(`http://${ip}:${WORKSPACE_PORT}`),
      supervisors: new Map(),
      fetcher: new TeloReleaseFetcher(
        { host: ip, port: supervisorPortFor(TOOLING_SLOT), token },
        this.deps.config.teloReleasesUrl,
        (termination) => this.supervisorEnded(this.runtime ?? undefined, "tooling", termination),
      ),
      abort: new AbortController(),
      stopWatch: () => {},
      failed: false,
    };
  }

  /** `running` with the endpoints, then each app's state as it stands. */
  private reportRunning(rt: PodRuntime): void {
    const agent = this.agentEndpoint();
    this.callbacks.onStatus({
      kind: "running",
      endpoints: endpointsFor(this.deps.config, this.spec.sessionId, allPorts(this.apps), Boolean(this.deps.router)),
      ...(agent ? { agent } : {}),
    });
    for (const supervisor of rt.supervisors.values()) supervisor.report();
  }

  private async connectSupervisors(rt: PodRuntime, timeoutMs: number): Promise<void> {
    const apps = this.apps.map((app) => this.addSupervisor(rt, app.name));
    await Promise.all([...apps.map((s) => s.connect(timeoutMs)), rt.fetcher.connect(timeoutMs)]);
  }

  /** The supervisor of the slot `app` holds, not yet connected. */
  private addSupervisor(rt: PodRuntime, app: string): SupervisedApp {
    const supervisor = new SupervisedApp(
      {
        host: rt.ip,
        port: supervisorPortFor(this.slotOf(app)),
        token: rt.token,
        label: `slot ${this.slotOf(app)} of container '${APPS_CONTAINER}'`,
      },
      {
        onAppState: (state) => {
          if (this.runtime === rt) this.callbacks.onAppState(app, state);
        },
        onOutput: (chunk, stream) => {
          if (this.runtime === rt) this.callbacks.onOutput(app, chunk, stream);
        },
        onTerminated: (termination) => this.supervisorEnded(rt, app, termination),
      },
    );
    rt.supervisors.set(app, supervisor);
    return supervisor;
  }

  /** A supervisor connection ended for good: the container can no longer be
   *  driven, which is the session's infrastructure failure. */
  private supervisorEnded(rt: PodRuntime | undefined, what: string, termination: SupervisorTermination): void {
    if (!rt) return;
    this.failPod(
      rt,
      termination.kind === "generation_mismatch"
        ? `container '${APPS_CONTAINER}' runs a session supervisor of another protocol generation; ` +
            `resume the session to recreate its pod`
        : `the session supervisor of '${what}' in container '${APPS_CONTAINER}' can no longer be reached ` +
            `(${termination.kind}): ${termination.message}`,
    );
  }

  /** Write the slot assignment onto the pod, where an adopting runner reads it. */
  private async recordSlots(rt: PodRuntime): Promise<void> {
    const { kube, config } = this.deps;
    const pod = await kube.core.readNamespacedPod({ name: rt.name, namespace: config.sessionNamespace });
    await kube.core.replaceNamespacedPod({
      name: rt.name,
      namespace: config.sessionNamespace,
      body: {
        ...pod,
        metadata: {
          ...pod.metadata,
          annotations: { ...pod.metadata?.annotations, [APP_SLOTS_ANNOTATION]: JSON.stringify(this.slots) },
        },
      },
    });
  }

  private failPod(rt: PodRuntime, message: string): void {
    if (this.runtime !== rt || rt.failed) return;
    rt.failed = true;
    this.callbacks.onStatus({ kind: "failed", message });
  }

  /** Resolve with the pod IP once Running, streaming provisioning messages. */
  private async waitForRunning(name: string): Promise<string> {
    const { kube, config } = this.deps;
    let lastProvision: string | undefined;
    const deadline = Date.now() + START_DEADLINE_MS;
    for (;;) {
      let current: V1Pod;
      try {
        current = await kube.core.readNamespacedPod({ name, namespace: config.sessionNamespace });
      } catch (err) {
        if (is404(err)) throw new Error("the pod disappeared before reaching Running");
        throw withCause(new Error(`could not read the session pod: ${apiReason(err)}`), err);
      }
      const ended = endedContainer(current);
      if (ended) throw new Error(ended);
      const phase = podPhase(current);
      if (phase === "Running") {
        const ip = podStatus(current)?.podIP;
        if (ip) return ip;
      } else if (phase === "Failed" || phase === "Succeeded") {
        throw new Error(`the pod reached ${phase}: ${podFailureMessage(current)}`);
      } else {
        const provision = provisionMessage(current);
        if (provision && provision !== lastProvision) {
          lastProvision = provision;
          this.callbacks.onProgress("provision", provision);
        }
      }
      if (Date.now() > deadline) {
        throw new Error(
          `the pod did not reach Running within ${START_DEADLINE_MS / 1000}s` +
            (lastProvision ? ` (last: ${lastProvision})` : ""),
        );
      }
      await sleep(POLL_MS);
    }
  }

  private async waitForWorkspace(client: WorkspaceClient): Promise<void> {
    const deadline = Date.now() + WORKSPACE_READY_TIMEOUT_MS;
    this.callbacks.onProgress("boot", "Starting workspace");
    let lastError = "no response";
    for (;;) {
      try {
        await client.tree();
        return;
      } catch (err) {
        lastError = msg(err);
      }
      if (Date.now() > deadline) {
        throw new SessionStartError(
          "start_failed",
          "start",
          `workspace container did not become ready: ${lastError}`,
          lastError,
        );
      }
      await sleep(POLL_MS);
    }
  }

  /**
   * A watch on the pod: a container that ends, a pod that fails or is deleted
   * from under the session is the session's infrastructure failure. With
   * `restartPolicy: Never` and other containers still up, the pod stays Running
   * when one container dies, so the container statuses are where that lives.
   */
  private armPodWatch(rt: PodRuntime): void {
    const { kube, config } = this.deps;
    let stopped = false;
    const arm = async (): Promise<void> => {
      if (stopped) return;
      try {
        const req = await kube.watch.watch(
          `/api/v1/namespaces/${config.sessionNamespace}/pods`,
          { fieldSelector: `metadata.name=${rt.name}` },
          (type: string, obj: unknown) => {
            if (stopped) return;
            if (type === "DELETED") return this.failPod(rt, "the session pod was deleted");
            const ended = endedContainer(obj);
            if (ended) return this.failPod(rt, ended);
            const phase = podPhase(obj);
            if (phase === "Failed" || phase === "Succeeded") {
              this.failPod(rt, `the session pod reached ${phase}: ${podFailureMessage(obj)}`);
            }
          },
          () => {
            if (!stopped) setTimeout(() => void arm(), WATCH_REARM_DELAY_MS).unref?.();
          },
        );
        rt.stopWatch = () => {
          stopped = true;
          (req as { abort?: () => void }).abort?.();
        };
      } catch {
        // A watch that cannot be armed now is armed again; the pod's state is
        // read afresh by the next watch's initial events.
        if (!stopped) setTimeout(() => void arm(), WATCH_REARM_DELAY_MS).unref?.();
      }
    };
    rt.stopWatch = () => {
      stopped = true;
    };
    void arm();
  }

  /** Delete the pod and keep the storage. Resolves once the pod is gone, so a
   *  replacement never shares the volume with it. */
  private async teardown(): Promise<void> {
    const rt = this.runtime;
    this.runtime = null;
    if (!rt) return;
    stopWatchers(rt);
    await closeSupervisors(rt);
    const { kube, config } = this.deps;
    if (rt.failed && config.keepFailedPods) await keepPod(kube, config.sessionNamespace, rt.name);
    else await deletePodAndWait(kube, config.sessionNamespace, rt.name);
  }

  // ---- Routing ----------------------------------------------------------------

  /** Where this session's co-resident agent answers: its port joins the
   *  session's Service, under the same host scheme as every app port. */
  private agentEndpoint(): RunnerEndpoint | undefined {
    const port = this.agent?.port;
    if (port === undefined) return undefined;
    return endpointsFor(this.deps.config, this.spec.sessionId, [{ port, protocol: "tcp" }], Boolean(this.deps.router))[0];
  }

  /** Every port the session's Service and routing objects carry: the apps'
   *  declared ports plus the agent's. */
  private routedPorts(): PortMapping[] {
    const port = this.agent?.port;
    const ports = allPorts(this.apps);
    return port === undefined ? ports : [...ports, { port, protocol: "tcp" as const }];
  }

  /** Publish, and report a failure on the route channel rather than failing
   *  the session: the endpoints are advertised on `running`, so a log line
   *  alone would leave a URL that 404s with nothing said. */
  private async publishOrReport(rt: PodRuntime): Promise<void> {
    try {
      await this.publishEndpoints(rt);
    } catch (err) {
      const reason = `could not publish the session route: ${apiReason(err)}`;
      for (const p of this.routedPorts()) {
        if (p.protocol !== "tcp") continue;
        this.callbacks.onRoute(this.ownerOf(p.port), {
          host: hostForPort(this.deps.config, this.spec.sessionId, p.port),
          port: p.port,
          state: "unprogrammed",
          reason,
        });
      }
    }
  }

  /**
   * Create or re-patch the Service and the routing objects for the session's
   * whole routed port set. An EMPTY set still reaches the router, because
   * dropping the last declared port must take its routes with it.
   */
  private async publishEndpoints(rt: PodRuntime): Promise<void> {
    const router = this.deps.router;
    if (!router) return;
    const { kube, config } = this.deps;
    const ns = config.sessionNamespace;
    const ports = this.routedPorts();
    const serviceName = sessionObjectName(this.spec.sessionId);
    if (ports.length > 0) {
      const service = buildSessionService(config, this.spec.sessionId, rt.name, rt.uid, ports);
      await createOrReplace(
        () => kube.core.createNamespacedService({ namespace: ns, body: service }),
        async () => {
          // A replace must carry the assigned `clusterIP` (immutable) and the
          // current `resourceVersion` (what makes it conflict, not clobber).
          const existing = await kube.core.readNamespacedService({ name: serviceName, namespace: ns });
          await kube.core.replaceNamespacedService({
            name: serviceName,
            namespace: ns,
            body: {
              ...service,
              metadata: { ...service.metadata, resourceVersion: existing.metadata?.resourceVersion },
              spec: { ...service.spec, clusterIP: existing.spec?.clusterIP, clusterIPs: existing.spec?.clusterIPs },
            },
          });
        },
      );
    }
    const published = await router.publish({
      sessionId: this.spec.sessionId,
      serviceName,
      podName: rt.name,
      podUid: rt.uid,
      ports,
    });
    this.watchRoutes(rt, router, published);
  }

  /** Verify the routing layer programmed what was just published; a republish
   *  drops the previous watch. */
  private watchRoutes(rt: PodRuntime, router: SessionRouter, published: PublishedRoute[]): void {
    rt.routeAbort?.abort();
    if (published.length === 0) return;
    const abort = new AbortController();
    rt.routeAbort = abort;
    void watchRouteHealth({
      router,
      sessionId: this.spec.sessionId,
      routes: published,
      onState: (route, state, reason) =>
        this.callbacks.onRoute(this.ownerOf(route.port), { host: route.host, port: route.port, state, reason }),
      signal: AbortSignal.any([abort.signal, rt.abort.signal]),
      timeoutMs: this.deps.config.sessionRouting.routeReadyTimeoutMs,
    });
  }

  /** The app declaring a port; the agent's port belongs to none. */
  private ownerOf(port: number): string | undefined {
    return this.apps.find((a) => a.ports.some((p) => p.port === port))?.name;
  }

  private async rerouteApp(appName: string, declared: PortMapping[]): Promise<void> {
    const rt = this.runtime;
    const app = this.apps.find((a) => a.name === appName);
    if (!rt || !app) return;
    const { config } = this.deps;
    const sessionId = this.spec.sessionId;
    const routed = Boolean(this.deps.router);

    const before = new Map(app.ports.map((p) => [portKey(p), p]));
    const after = new Map(declared.map((p) => [portKey(p), p]));
    const added = declared.filter((p) => !before.has(portKey(p)));
    const removed = app.ports.filter((p) => !after.has(portKey(p)));
    // A reload adding a `Telo.PublicUrl` changes a kept port's hosts, not its ports.
    const rehosted = app.ports.filter((p) => {
      const now = after.get(portKey(p));
      return now !== undefined && (now.publicHosts ?? []).join(",") !== (p.publicHosts ?? []).join(",");
    });
    if (added.length === 0 && removed.length === 0 && rehosted.length === 0) return;
    if (added.length === 0 && removed.length === 0) {
      app.ports = app.ports.map((p) => after.get(portKey(p)) ?? p);
      try {
        await this.publishEndpoints(rt);
      } catch (err) {
        this.callbacks.onEndpoints(appName, {
          rejected: rehosted.map((p) => ({ port: p.port, reason: apiReason(err) })),
        });
      }
      return;
    }

    // Taken: another app's port (session hosts carry no app name), the agent's
    // (same pod IP, same Service) and every port the pod binds for an app's
    // supervisor or debug stream (one network namespace).
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
    for (const r of reservedPortsFor()) {
      taken.set(portKey(r), `this runner reserves ${r.protocol} port ${r.port} for ${r.purpose}`);
    }
    const rejected = added.filter((p) => taken.has(portKey(p)));
    const accepted = added.filter((p) => !taken.has(portKey(p)));

    app.ports = [...app.ports.filter((p) => after.has(portKey(p))).map((p) => after.get(portKey(p))!), ...accepted];

    try {
      await this.publishEndpoints(rt);
    } catch (err) {
      this.callbacks.onEndpoints(appName, {
        rejected: accepted.map((p) => ({ port: p.port, reason: apiReason(err) })),
      });
      return;
    }
    this.callbacks.onEndpoints(appName, {
      ...(accepted.length > 0 ? { added: endpointsFor(config, sessionId, accepted, routed) } : {}),
      ...(removed.length > 0 ? { removed: endpointsFor(config, sessionId, removed, routed) } : {}),
      ...(rejected.length > 0
        ? { rejected: rejected.map((p) => ({ port: p.port, reason: taken.get(portKey(p))! })) }
        : {}),
    });
  }

  // ---- Lookups ----------------------------------------------------------------

  private requireRuntime(): PodRuntime {
    if (!this.runtime) throw new Error("the session's pod is being replaced");
    return this.runtime;
  }

  private currentWorkspace(): WorkspaceClient {
    return this.requireRuntime().workspace;
  }

  private indexOf(app: string): number {
    const index = this.apps.findIndex((a) => a.name === app);
    if (index < 0) throw new Error(`the session runs no app named '${app}'`);
    return index;
  }

  private slotOf(app: string): number {
    const slot = this.slots[app];
    if (slot === undefined) throw new Error(`the session runs no app named '${app}'`);
    return slot;
  }

  private supervisorOf(app: string): SupervisedApp {
    const supervisor = this.requireRuntime().supervisors.get(app);
    if (!supervisor) throw new Error(`the session runs no app named '${app}'`);
    return supervisor;
  }
}

/** What an adopting runner reads back from a running pod's spec, or why the
 *  pod is not the one the stored session describes. */
function readAdoptable(
  pod: V1Pod,
  spec: SessionWorkloadSpec,
  kernelImage: string,
):
  | { ip: string; supervisorToken: string; slots: Record<string, number>; agentToken: string | undefined }
  | { stale: string } {
  const ip = podStatus(pod)?.podIP;
  if (!ip) return { stale: "it has no address" };
  const containers = pod.spec?.containers ?? [];
  const apps = containers.find((c) => c.name === APPS_CONTAINER);
  if (!apps) return { stale: `it has no '${APPS_CONTAINER}' container` };
  const env = envOf(apps.env);
  const supervisorToken = env[SUPERVISOR_TOKEN_ENV];
  if (!supervisorToken || env[SUPERVISOR_LISTEN_ENV] !== `0.0.0.0:${supervisorPortFor(0)}`) {
    return { stale: `container '${APPS_CONTAINER}' runs no session supervisor this runner can reach` };
  }
  const slots = readSlots(pod);
  if (!slots) return { stale: "it records no app slots" };
  const names = Object.keys(slots).sort().join(",");
  if (names !== spec.apps.map((a) => a.name).sort().join(",")) {
    return { stale: "its app slots are not the stored app set" };
  }
  const agentContainer = containers.find((c) => c.name === "agent");
  if (Boolean(agentContainer) !== Boolean(spec.agent) || (spec.agent && agentContainer!.image !== agentImage(spec.agent, kernelImage))) {
    return { stale: "its agent is not the stored agent" };
  }
  let agentToken: string | undefined;
  if (spec.agent?.tokenEnv !== undefined) {
    agentToken = envOf(agentContainer!.env)[spec.agent.tokenEnv];
    if (!agentToken) return { stale: `its agent carries no ${spec.agent.tokenEnv}` };
  }
  return { ip, supervisorToken, slots, agentToken };
}

function readSlots(pod: V1Pod): Record<string, number> | undefined {
  const raw = pod.metadata?.annotations?.[APP_SLOTS_ANNOTATION];
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries = Object.entries(parsed);
    if (entries.some(([, slot]) => !Number.isInteger(slot) || (slot as number) < 0 || (slot as number) >= APP_SLOTS)) {
      return undefined;
    }
    return parsed as Record<string, number>;
  } catch {
    return undefined;
  }
}

/** Keep every kept app's slot, free the removed apps', and give each new app the
 *  lowest free one. */
function assignSlots(current: Record<string, number>, apps: BackendAppSpec[]): Record<string, number> {
  const next: Record<string, number> = {};
  const used = new Set<number>();
  for (const app of apps) {
    const slot = current[app.name];
    if (slot !== undefined) {
      next[app.name] = slot;
      used.add(slot);
    }
  }
  for (const app of apps) {
    if (next[app.name] !== undefined) continue;
    let slot = 0;
    while (used.has(slot)) slot += 1;
    next[app.name] = slot;
    used.add(slot);
  }
  return next;
}

function envOf(env: Array<{ name: string; value?: string }> | undefined): Record<string, string> {
  return Object.fromEntries((env ?? []).map((e) => [e.name, e.value ?? ""]));
}

function withAgentToken(agent: RunnerAgent | undefined, token: string | undefined): RunnerAgent | undefined {
  if (!agent || agent.tokenEnv === undefined || token === undefined) return agent;
  return { ...agent, env: { ...agent.env, [agent.tokenEnv]: token } };
}

function copyApp(app: BackendAppSpec): BackendAppSpec {
  return { ...app, ports: app.ports.map((p) => ({ ...p })) };
}

function allPorts(apps: BackendAppSpec[]): PortMapping[] {
  return apps.flatMap((a) => a.ports);
}

function stopWatchers(rt: PodRuntime): void {
  rt.stopWatch();
  rt.routeAbort?.abort();
  rt.abort.abort();
}

async function closeSupervisors(rt: PodRuntime): Promise<void> {
  await Promise.all([...rt.supervisors.values()].map((s) => s.close()));
  await rt.fetcher.close();
}

/** Every pod a session ever creates gets its own name: the pod it replaces may
 *  still be terminating. Lookup and reaping key on the label, never the name. */
let podSequence = 0;

function freshPodName(sessionId: string): string {
  podSequence += 1;
  return `telo-session-${sessionId}-${Date.now().toString(36)}${podSequence.toString(36)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}
