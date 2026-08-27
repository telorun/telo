import { PassThrough, Writable } from "node:stream";

import type { V1Pod } from "@kubernetes/client-node";
import type {
  BackendAppSpec,
  BackendSession,
  BackendStartSpec,
  DebugFrame,
  PortMapping,
  RunStatus,
  WorkspaceAccess,
} from "@telorun/runner-core";
import {
  portKey,
  portsResolvedFrom,
  relayDebugStream,
  SessionStartError,
  watchReachability,
  workspaceMarkerWrite,
  WorkspaceClient,
} from "@telorun/runner-core";

import type { K8sRunnerConfig } from "../config.js";
import { clampLimits } from "../limits.js";
import type { KubeClient } from "./client.js";
import { buildSessionIngress, buildSessionService, endpointsFor } from "./ingress.js";
import { buildWatchPod, inspectPortFor, WORKSPACE_PORT } from "./pod-spec.js";
import { deletePod, is404, msg, podPhase, podStatus, provisionMessage } from "./pod-status.js";
import { ensureWorkspaceConfigMap } from "./workspace-configmap.js";

/** How long the pod may take to reach Running before the start is abandoned.
 *  `activeDeadlineSeconds` only bounds an already-running pod. */
const START_DEADLINE_MS = 180_000;
const WATCH_REARM_DELAY_MS = 2_000;
/** How long to wait for the workspace container's HTTP surface to answer before
 *  giving up on the seed. It is a kernel boot plus a module resolve, so it is
 *  slower than the pod reaching Running. */
const WORKSPACE_READY_TIMEOUT_MS = 120_000;
const WORKSPACE_POLL_MS = 500;
const RESIZE_CHANNEL = 4;

interface ResizableSocket {
  send(data: Buffer): void;
  close(): void;
}

export interface WatchSessionDeps {
  kube: KubeClient;
  config: K8sRunnerConfig;
}

/**
 * A watch session: one pod, one workspace volume, one container per running
 * application, and the session outliving every run inside it.
 *
 * What it does NOT do is as load-bearing as what it does: it never builds an
 * image. The build path exists to put a dependency closure on disk before boot;
 * a watch session resolves its own into a per-app cache directory that lives as
 * long as the pod, so the download happens once per app per session and every
 * later reload resolves from local disk.
 */
export async function startWatchSession(
  deps: WatchSessionDeps,
  spec: BackendStartSpec,
): Promise<BackendSession> {
  const { kube, config } = deps;
  const ns = config.sessionNamespace;
  const limits = clampLimits(config.appLimits, undefined);

  let apps = spec.apps;
  let podName = freshPodName(spec.sessionId);
  let userStopped = false;

  const workspaceAppConfigMap = await ensureWorkspaceConfigMap(kube, config);

  /** Everything tied to ONE pod. A pod recreate (resume, or a change to the app
   *  set) replaces this wholesale rather than reconciling it in place: the
   *  container list is fixed at creation, so nothing about the old pod survives. */
  interface PodRuntime {
    name: string;
    uid: string;
    ip: string;
    workspace: WorkspaceClient;
    sockets: Map<string, ResizableSocket>;
    stdins: Map<string, PassThrough>;
    abort: AbortController;
    stopWatch: () => void;
  }
  let runtime: PodRuntime | null = null;

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  let settled = false;
  const settle = (status: RunStatus): void => {
    if (settled) return;
    settled = true;
    spec.onStatus(status);
    resolveDone();
  };

  async function bringUp(seed: boolean): Promise<void> {
    const pod = buildWatchPod({
      config,
      sessionId: spec.sessionId,
      podName,
      env: spec.env,
      apps,
      agent: spec.agent,
      limits,
      image: spec.config.image || config.defaultImage,
      pullPolicy: spec.config.pullPolicy,
      workspaceAppConfigMap,
    });

    let created: V1Pod;
    try {
      created = await kube.core.createNamespacedPod({ namespace: ns, body: pod });
    } catch (err) {
      throw new SessionStartError(
        "start_failed",
        "create",
        `failed to create pod: ${msg(err)}`,
        msg(err),
      );
    }

    const abort = new AbortController();
    const ip = await waitForRunning(podName, abort);

    const workspace = new WorkspaceClient(`http://${ip}:${WORKSPACE_PORT}`);
    await waitForWorkspace(workspace, abort.signal);

    // The bundle reaches the volume through the SAME surface every later write
    // takes — which is what lets the body-fetch init container and the tokenized
    // tarball go away. App containers wait for their entry manifest to exist, so
    // none of them has failed a load in the meantime.
    if (seed) {
      await workspace.apply({
        write: [
          ...spec.bundle.files.map((f) => ({
            path: f.relativePath,
            content: f.contents,
            encoding: f.encoding ?? "utf8",
          })),
          // The workspace-root marker, so every app in this session anchors its
          // module cache at ONE place instead of one per entry directory.
          ...workspaceMarkerWrite(spec.bundle),
        ],
      });
    }

    endedApps.clear();
    runtime = {
      name: podName,
      uid: created.metadata?.uid ?? "",
      ip,
      workspace,
      sockets: new Map(),
      stdins: new Map(),
      abort,
      stopWatch: () => {},
    };

    await attachApps(runtime);
    await publishEndpoints(runtime, apps);
    relayDebug(runtime);
    watchPorts(runtime);
    armPodWatch(runtime);

    spec.onStatus({
      kind: "running",
      endpoints: endpointsFor(config, spec.sessionId, allPorts(apps)),
    });
  }

  /** Resolve once the pod is Running, streaming provisioning messages meanwhile.
   *  Rejects with the pod's own failure detail rather than a timeout when the
   *  pod itself failed — the two send a reader to different places. */
  async function waitForRunning(name: string, abort: AbortController): Promise<string> {
    let lastProvision: string | undefined;
    const deadline = Date.now() + START_DEADLINE_MS;
    for (;;) {
      if (abort.signal.aborted) throw new Error("session stopped while the pod was coming up");
      let current: V1Pod;
      try {
        current = await kube.core.readNamespacedPod({ name, namespace: ns });
      } catch (err) {
        if (is404(err)) throw new Error("pod disappeared before reaching Running");
        throw err;
      }
      const phase = podPhase(current);
      if (phase === "Running") {
        const ip = podStatus(current)?.podIP;
        if (ip) return ip;
      } else if (phase === "Failed" || phase === "Succeeded") {
        throw new Error(`pod reached ${phase} before serving`);
      } else {
        const provision = provisionMessage(current);
        if (provision && provision !== lastProvision) {
          lastProvision = provision;
          spec.onProgress("provision", provision);
        }
      }
      if (Date.now() > deadline) {
        throw new Error("pod did not reach Running within the start deadline");
      }
      await sleep(WORKSPACE_POLL_MS, abort.signal);
    }
  }

  /** The workspace container is a kernel boot plus a module resolve, so being
   *  Running is not being ready. Every write — the seed above all — depends on
   *  it, so this waits rather than letting the first write fail. */
  async function waitForWorkspace(client: WorkspaceClient, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + WORKSPACE_READY_TIMEOUT_MS;
    spec.onProgress("boot", "Starting workspace");
    let lastError = "no response";
    for (;;) {
      if (signal.aborted) throw new Error("session stopped while the workspace was coming up");
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
      await sleep(WORKSPACE_POLL_MS, signal);
    }
  }

  /** One attach per app container: each has its own terminal, so the byte
   *  channel is keyed `(session, app)` rather than labelled on a merged stream. */
  async function attachApps(rt: PodRuntime): Promise<void> {
    for (const app of apps) {
      const stdin = new PassThrough();
      const stdout = new Writable({
        write(chunk: Buffer, encoding, cb) {
          if (chunk?.byteLength) spec.onOutput(app.name, Buffer.from(chunk), tagFor(app, "stdout"));
          cb();
        },
      });
      // Under `io: "streams"` the kubernetes attach subresource gives separate
      // stdout and stderr channels — the demux is already there, and a TTY is
      // what collapses it. So the split is real, not a label.
      const stderr =
        app.io === "streams"
          ? new Writable({
              write(chunk: Buffer, encoding, cb) {
                if (chunk?.byteLength) spec.onOutput(app.name, Buffer.from(chunk), "stderr");
                cb();
              },
            })
          : null;
      try {
        const ws = await kube.attach.attach(
          ns,
          rt.name,
          `app-${app.name}`,
          stdout,
          stderr,
          stdin,
          app.io === "tty",
        );
        rt.sockets.set(app.name, ws as unknown as ResizableSocket);
        rt.stdins.set(app.name, stdin);
      } catch (err) {
        // A degraded terminal is not a failed session — status, run events and
        // the workspace all still work — so it is reported on that app's own
        // channel rather than aborting the start.
        spec.onOutput(
          app.name,
          Buffer.from(`\r\n[runner] failed to attach: ${msg(err)}\r\n`),
          tagFor(app, "stderr"),
        );
      }
    }
  }

  function relayDebug(rt: PodRuntime): void {
    apps.forEach((app, index) => {
      void relayDebugStream({
        url: `http://${rt.ip}:${inspectPortFor(index)}/events`,
        onFrame: (frame) => {
          void applyPortsResolved(app.name, frame);
          spec.onDebug(app.name, frame);
        },
        signal: rt.abort.signal,
      });
    });
  }

  /**
   * Re-route an app whose declared port set changed on reload.
   *
   * The kernel re-resolves its `ports:` block on every load and says so on the
   * stream the runner is already reading, so nothing here parses a manifest —
   * which matters, because a manifest the runner could not parse would otherwise
   * have to leave routing alone and report, on the hot path of every save.
   *
   * A pod's `containerPort` list is documentation; the Service and the Ingress
   * are what make a port reachable, so this needs no pod recreate.
   */
  async function applyPortsResolved(appName: string, frame: DebugFrame): Promise<void> {
    const declared = portsResolvedFrom(frame);
    if (!declared) return;
    const rt = runtime;
    const app = apps.find((a) => a.name === appName);
    if (!rt || !app) return;

    const before = new Map(app.ports.map((p) => [portKey(p), p]));
    const after = new Map(declared.map((p) => [portKey(p), p]));
    const added = declared.filter((p) => !before.has(portKey(p)));
    const removed = app.ports.filter((p) => !after.has(portKey(p)));
    if (added.length === 0 && removed.length === 0) return;

    // A port another app in this session already owns cannot be routed: session
    // hosts are `<port>-<sessionId>`, a single label carrying no app name. It is
    // reported against the app that asked for it, never dropped.
    const taken = new Set(
      apps.filter((a) => a.name !== appName).flatMap((a) => a.ports.map(portKey)),
    );
    const rejected = added.filter((p) => taken.has(portKey(p)));
    const accepted = added.filter((p) => !taken.has(portKey(p)));

    app.ports = [...app.ports.filter((p) => after.has(portKey(p))), ...accepted];

    try {
      await publishEndpoints(rt, apps);
    } catch (err) {
      spec.onEndpoints(appName, {
        rejected: accepted.map((p) => ({ port: p.port, reason: msg(err) })),
      });
      return;
    }
    spec.onEndpoints(appName, {
      ...(accepted.length > 0
        ? { added: endpointsFor(config, spec.sessionId, accepted) }
        : {}),
      ...(removed.length > 0
        ? { removed: endpointsFor(config, spec.sessionId, removed) }
        : {}),
      ...(rejected.length > 0
        ? {
            rejected: rejected.map((p) => ({
              port: p.port,
              reason: `another app in this session already declares ${p.protocol} port ${p.port}`,
            })),
          }
        : {}),
    });

    const tcp = accepted.filter((p) => p.protocol === "tcp").map((p) => p.port);
    if (tcp.length > 0) {
      void watchReachability({
        host: rt.ip,
        ports: tcp,
        onState: (port, state) => spec.onReachability(appName, port, state),
        signal: rt.abort.signal,
      });
    }
  }

  function watchPorts(rt: PodRuntime): void {
    for (const app of apps) {
      const tcp = app.ports.filter((p) => p.protocol === "tcp").map((p) => p.port);
      if (tcp.length === 0) continue;
      void watchReachability({
        host: rt.ip,
        ports: tcp,
        onState: (port, state) => spec.onReachability(app.name, port, state),
        signal: rt.abort.signal,
      });
    }
  }

  /** Apps whose container has already been reported ended, so a repeated watch
   *  event does not re-report it. Cleared when a pod is replaced. */
  const endedApps = new Set<string>();

  /**
   * Report an `app-<name>` container that has terminated.
   *
   * `restartPolicy: Never` plus a `workspace` container that runs forever means
   * a pod whose application container died stays **Running** — so pod phase
   * alone never notices, and the app is silently dead while the editor still
   * shows it running. The container statuses are where that fact lives.
   *
   * A run ENDING is not the session ending: the rest of the session is up and
   * the next edit starts the next generation, which is why this reports a run
   * outcome rather than a status.
   */
  function noteEndedContainers(obj: unknown): void {
    if (userStopped) return;
    for (const status of podStatus(obj)?.containerStatuses ?? []) {
      const name = status.name ?? "";
      if (!name.startsWith("app-")) continue;
      const terminated = status.state?.terminated;
      if (!terminated) continue;
      const appName = name.slice("app-".length);
      if (endedApps.has(appName)) continue;
      endedApps.add(appName);
      spec.onRunEnded(appName, {
        reason:
          terminated.reason && terminated.reason !== "Completed"
            ? `application container ${terminated.reason} (exit code ${terminated.exitCode ?? "unknown"})`
            : `application container exited (code ${terminated.exitCode ?? "unknown"})`,
      });
    }
  }

  /** A watch on the pod, so a container that dies unrecoverably fails the
   *  session instead of leaving a stream that has simply gone quiet. */
  function armPodWatch(rt: PodRuntime): void {
    let stopped = false;
    const arm = async (): Promise<void> => {
      if (stopped) return;
      try {
        const req = await kube.watch.watch(
          `/api/v1/namespaces/${ns}/pods`,
          { fieldSelector: `metadata.name=${rt.name}` },
          (type: string, obj: unknown) => {
            if (stopped) return;
            noteEndedContainers(obj);
            const phase = podPhase(obj);
            if (phase === "Failed" || phase === "Succeeded") {
              // A watch session's pod reaching a terminal phase is never a
              // normal run ending — a run ending leaves the pod up. So it is a
              // session failure unless the user asked for it.
              settle(
                userStopped
                  ? { kind: "stopped" }
                  : { kind: "failed", message: `session pod reached ${phase}` },
              );
            }
          },
          () => {
            if (stopped) return;
            setTimeout(() => void arm(), WATCH_REARM_DELAY_MS).unref?.();
          },
        );
        rt.stopWatch = () => {
          stopped = true;
          try {
            (req as { abort?: () => void }).abort?.();
          } catch {
            /* already gone */
          }
        };
      } catch {
        if (!stopped) setTimeout(() => void arm(), WATCH_REARM_DELAY_MS).unref?.();
      }
    };
    void arm();
  }

  /**
   * Create or re-patch the Service and Ingress for the session's whole declared
   * port set. Adding a `ports:` entry is as ordinary an edit as adding an
   * import, and a container may bind any port regardless of what the pod spec
   * declares — so without this the app listens and is simply unreachable: no
   * ingress, no error, no event. The pod's `containerPort` list is
   * documentation; the Service and Ingress are what make a port reachable, which
   * is why this needs no pod recreate.
   */
  async function publishEndpoints(rt: PodRuntime, forApps: BackendAppSpec[]): Promise<void> {
    if (!config.sessionIngressBaseDomain) return;
    const ports = allPorts(forApps);
    if (ports.length === 0) return;
    const service = buildSessionService(config, spec.sessionId, rt.name, rt.uid, ports);
    const serviceName = service.metadata!.name!;
    await upsert(
      () => kube.core.createNamespacedService({ namespace: ns, body: service }),
      async () => {
        // A Service replace must carry the assigned `clusterIP` and the current
        // `resourceVersion`: the first is immutable and an empty one is rejected
        // outright, the second is what makes the write conflict rather than
        // clobber. Reading first is not optional here.
        const existing = await kube.core.readNamespacedService({ name: serviceName, namespace: ns });
        await kube.core.replaceNamespacedService({
          name: serviceName,
          namespace: ns,
          body: {
            ...service,
            metadata: {
              ...service.metadata,
              resourceVersion: existing.metadata?.resourceVersion,
            },
            spec: {
              ...service.spec,
              clusterIP: existing.spec?.clusterIP,
              clusterIPs: existing.spec?.clusterIPs,
            },
          },
        });
      },
    );
    const { ingress } = buildSessionIngress(
      config,
      spec.sessionId,
      serviceName,
      rt.name,
      rt.uid,
      ports,
    );
    if (!ingress.spec?.rules?.length) return;
    const ingressName = ingress.metadata!.name!;
    await upsert(
      () => kube.networking.createNamespacedIngress({ namespace: ns, body: ingress }),
      async () => {
        const existing = await kube.networking.readNamespacedIngress({
          name: ingressName,
          namespace: ns,
        });
        await kube.networking.replaceNamespacedIngress({
          name: ingressName,
          namespace: ns,
          body: {
            ...ingress,
            metadata: {
              ...ingress.metadata,
              resourceVersion: existing.metadata?.resourceVersion,
            },
          },
        });
      },
    );
  }

  async function teardownPod(): Promise<void> {
    const rt = runtime;
    runtime = null;
    if (!rt) return;
    rt.stopWatch();
    rt.abort.abort();
    for (const socket of rt.sockets.values()) {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
    await deletePod(kube, ns, rt.name);
  }

  await bringUp(true);

  return {
    writeStdin(app, bytes) {
      try {
        runtime?.stdins.get(app)?.write(Buffer.from(bytes));
      } catch {
        /* stream ended */
      }
    },
    resize(app, cols, rows) {
      const socket = runtime?.sockets.get(app);
      if (!socket) return;
      try {
        const payload = Buffer.from(JSON.stringify({ Width: cols, Height: rows }));
        socket.send(Buffer.concat([Buffer.from([RESIZE_CHANNEL]), payload]));
      } catch {
        /* socket gone */
      }
    },
    done,
    get workspace(): WorkspaceAccess | undefined {
      return runtime?.workspace;
    },
    async reload(app) {
      const rt = runtime;
      const spec_ = apps.find((a) => a.name === app);
      if (!rt || !spec_) return;
      await rt.workspace.touch(spec_.entryRelativePath);
    },
    async setApps(next) {
      // A pod's container list is fixed at creation, so this is suspend+resume
      // with a different set — the same path, reused because it has to be. The
      // alternatives were a pod per app (needing ReadWriteMany storage for the
      // shared workspace), pre-allocated slots, or a supervisor owning child
      // kernels inside one container; all three cost more.
      const files = await runtime?.workspace.snapshot();
      await teardownPod();
      apps = next;
      podName = freshPodName(spec.sessionId);
      await bringUp(false);
      if (files && files.length > 0) {
        await runtime!.workspace.apply({
          write: files.map((f) => ({ path: f.path, content: f.content, encoding: f.encoding })),
        });
      }
    },
    async suspend() {
      // `teardownPod` stops the pod watch before deleting, so the delete is not
      // reported as the session failing.
      await teardownPod();
    },
    async stop() {
      userStopped = true;
      await teardownPod();
      settle({ kind: "stopped" });
    },
  };

  function tagFor(app: BackendAppSpec, real: "stdout" | "stderr"): "tty" | "stdout" | "stderr" {
    return app.io === "tty" ? "tty" : real;
  }

  async function upsert(create: () => Promise<unknown>, replace: () => Promise<unknown>) {
    try {
      await create();
    } catch (err) {
      if (!isConflict(err)) throw err;
      await replace();
    }
  }
}

function allPorts(apps: BackendAppSpec[]): PortMapping[] {
  return apps.flatMap((a) => a.ports);
}

/** Every pod a session ever creates gets its own name. A resumed session reuses
 *  its ID but must not reuse the name: the pod it replaces may still be
 *  terminating, and creating over a terminating name races the API server's own
 *  delete. Reaping and session lookup key on the label, never on the name.
 *
 *  The counter is what makes two recreates in the same millisecond distinct;
 *  the clock is what makes a name from a LATER closure (a resume builds a fresh
 *  one) distinct from an earlier closure's. Neither alone is enough. */
let podSequence = 0;

function freshPodName(sessionId: string): string {
  podSequence += 1;
  return `telo-watch-${sessionId}-${Date.now().toString(36)}${podSequence.toString(36)}`;
}

function isConflict(err: unknown): boolean {
  const e = err as { statusCode?: number; code?: number; response?: { statusCode?: number } };
  return (e?.statusCode ?? e?.code ?? e?.response?.statusCode) === 409;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
