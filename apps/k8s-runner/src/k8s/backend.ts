import { PassThrough, Writable } from "node:stream";

import type { V1Pod } from "@kubernetes/client-node";
import type {
  AvailabilityReport,
  BackendSession,
  BackendStartSpec,
  PortMapping,
  ProbeConfig,
  RunStatus,
  RunnerBackend,
} from "@telorun/runner-core";
import { relayDebugStream, SessionStartError, watchReachability } from "@telorun/runner-core";

import type { BundleStore } from "../bundle-store.js";
import type { K8sRunnerConfig } from "../config.js";
import { clampLimits } from "../limits.js";
import type { KubeClient } from "./client.js";
import { ensureSessionImage } from "./image-build.js";
import { buildSessionIngress, buildSessionService, endpointsFor } from "./ingress.js";
import { buildAppPod, buildSessionPod, INSPECT_PORT } from "./pod-spec.js";
import {
  deletePod,
  is404,
  msg,
  podFailureMessage,
  podStatus,
  podPhase,
  provisionMessage,
  terminalStatus,
} from "./pod-status.js";
import { startWatchSession } from "./watch-session.js";

export { podFailureMessage } from "./pod-status.js";

/** Minimal surface of the websocket client-node's Attach returns. */
interface ResizableSocket {
  send(data: Buffer): void;
  close(): void;
}

const RESIZE_CHANNEL = 4;
/** How long a Pod may take to reach Running before the start is abandoned.
 *  activeDeadlineSeconds only bounds an already-running Pod, so a stuck
 *  Pending/unschedulable Pod needs this separate runner-side deadline. */
const START_DEADLINE_MS = 120_000;
const WATCH_REARM_DELAY_MS = 2_000;

export interface K8sBackendDeps {
  kube: KubeClient;
  config: K8sRunnerConfig;
  bundleStore: BundleStore;
}

export function createKubernetesBackend(deps: K8sBackendDeps): RunnerBackend {
  const { kube, config, bundleStore } = deps;
  const ns = config.sessionNamespace;

  async function probe(probeConfig: ProbeConfig): Promise<AvailabilityReport> {
    try {
      await kube.core.readNamespace({ name: ns });
    } catch {
      const reachable = await clusterReachable(kube);
      if (!reachable) {
        return {
          status: "unavailable",
          message: "Kubernetes API server not reachable from the runner.",
          remediation: "Check the runner's in-cluster ServiceAccount and RBAC.",
        };
      }
      return {
        status: "unavailable",
        message: `Session namespace '${ns}' does not exist.`,
        remediation: `Install the runner's Helm chart, which provisions the '${ns}' namespace.`,
      };
    }
    return { status: "ready" };
  }

  async function start(spec: BackendStartSpec): Promise<BackendSession> {
    // A watch session is a different pod shape and a different lifetime — it
    // outlives its runs — so it takes its own path rather than accreting
    // branches through this one. It also never builds an image: the build path
    // exists to put a dependency closure on disk before boot, and a watch
    // session fetches its own and keeps it for the pod's life.
    if (spec.mode === "watch") {
      return startWatchSession({ kube, config }, spec);
    }
    return startRunSession(spec);
  }

  async function startRunSession(spec: BackendStartSpec): Promise<BackendSession> {
    const podName = `telo-run-${spec.sessionId}`;
    // A run session is one application by construction — `apps` carries exactly
    // one entry, defaulted by core when the request declared none.
    const app = spec.apps[0]!;
    const appName = app.name;
    // The /v1 contract carries no per-request limits yet, so `requested` is
    // undefined and the configured ceiling is always the effective limit. When
    // a control plane begins passing limits, plumb them here — the clamp is
    // already min(requested, ceiling). App sessions (operator-curated,
    // long-lived) get their own roomier ceilings.
    const limits = clampLimits(spec.selfContained ? config.appLimits : config.limits, undefined);

    let pod: V1Pod;
    if (spec.selfContained) {
      // Operator-predefined app (catalog image): self-contained, no build and
      // no bundle to deliver — the pod runs the image's own entrypoint with
      // the env the core route already merged.
      pod = buildAppPod({
        config,
        sessionId: spec.sessionId,
        podName,
        env: spec.env,
        ports: app.ports,
        limits,
        image: spec.config.image,
        pullPolicy: spec.config.pullPolicy,
      });
    } else {
      // Prebuild a self-contained per-app image on-cluster (controllers + module
      // manifests baked in) and run it directly. Controller resolution never
      // happens on the session start path, so a slow or unreachable package
      // registry can't stall a session. Throws SessionStartError on a build
      // failure, carrying the build pod's log tail.
      const image = await ensureSessionImage(
        {
          kube,
          build: config.build,
          bundleStore,
          initImage: config.initImage,
          managedByLabel: config.managedByLabel,
        },
        {
          bundle: spec.bundle,
          entryRelativePath: app.entryRelativePath,
          baseImage: spec.config.image || config.defaultImage,
          pullPolicy: spec.config.pullPolicy,
          onProgress: (message, done) => spec.onProgress("build", message, done, appName),
        },
      );

      // The image is keyed on the dependency closure only, so deliver the
      // per-session body to the Pod's /app at boot via a tokenized, single-use URL.
      const bundleUrl = await bundleStore.stageSessionBundle(spec.sessionId, spec.bundle);

      pod = buildSessionPod({
        config,
        sessionId: spec.sessionId,
        podName,
        entryRelativePath: app.entryRelativePath,
        env: spec.env,
        ports: app.ports,
        limits,
        image,
        bundleUrl,
        inspect: spec.inspect,
      });
    }

    let podUid: string;
    try {
      const created = await kube.core.createNamespacedPod({ namespace: ns, body: pod });
      podUid = created.metadata?.uid ?? "";
    } catch (err) {
      throw new SessionStartError("start_failed", "create", `failed to create pod: ${msg(err)}`, msg(err));
    }

    let finished = false;
    let runningSeen = false;
    let readyFlipped = false;
    let lastProvision: string | undefined;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    let socket: ResizableSocket | undefined;
    let abortWatch: () => void = () => {};
    let startDeadline: NodeJS.Timeout | undefined;
    let podIP: string | undefined;
    const debugAbort = new AbortController();
    const reachAbort = new AbortController();

    const stdin = new PassThrough();
    const stdout = new Writable({
      write(chunk: Buffer, encoding, cb) {
        if (chunk?.byteLength) spec.onOutput(appName, Buffer.from(chunk), "tty");
        cb();
      },
    });

    const clearStartDeadline = (): void => {
      if (startDeadline) {
        clearTimeout(startDeadline);
        startDeadline = undefined;
      }
    };

    const finish = (status: RunStatus): void => {
      if (finished) return;
      finished = true;
      clearStartDeadline();
      abortWatch();
      debugAbort.abort();
      reachAbort.abort();
      bundleStore.drop(spec.sessionId);
      spec.onStatus(status);
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      resolveDone();
    };

    // Flip the session to `running` when the pod reaches Running. Deterministic
    // and independent of the session image's telo version — a readiness signal
    // would couple this to the in-image CLI (and a stale base image would never
    // flip). The build/provision progress (streamed before this) covers the slow
    // part; the brief post-Running validation runs while already `running`.
    const flipRunning = (): void => {
      if (readyFlipped || finished) return;
      readyFlipped = true;
      spec.onStatus({ kind: "running", endpoints: endpointsFor(config, spec.sessionId, app.ports) });
    };

    let resolveRunning!: () => void;
    let rejectRunning!: (e: Error) => void;
    const running = new Promise<void>((res, rej) => {
      resolveRunning = res;
      rejectRunning = rej;
    });

    const handlePhase = (obj: unknown): void => {
      if (finished) return;
      const phase = podPhase(obj);
      // Coming-up feed: scheduling / pulling / body delivery / container create.
      if (!runningSeen) {
        const provision = provisionMessage(obj);
        if (provision && provision !== lastProvision) {
          lastProvision = provision;
          spec.onProgress("provision", provision, undefined, appName);
        }
      }
      if (phase === "Running" && !runningSeen) {
        runningSeen = true;
        podIP = podStatus(obj)?.podIP;
        clearStartDeadline();
        resolveRunning();
        flipRunning();
      } else if (phase === "Succeeded") {
        finish(terminalStatus(obj, spec.isUserStopped()));
      } else if (phase === "Failed") {
        if (!runningSeen) {
          clearStartDeadline();
          rejectRunning(new Error(podFailureMessage(obj)));
        }
        finish(terminalStatus(obj, spec.isUserStopped()));
      }
    };

    // One-shot reconcile — covers terminal transitions that landed during a
    // watch-reconnect gap, or a Pod that vanished entirely.
    const reconcileOnce = async (): Promise<void> => {
      if (finished) return;
      try {
        const current = await kube.core.readNamespacedPod({ name: podName, namespace: ns });
        handlePhase(current);
      } catch (err) {
        if (!is404(err)) return;
        if (!runningSeen) {
          clearStartDeadline();
          rejectRunning(new Error("pod disappeared before reaching Running"));
        } else {
          finish({ kind: "failed", message: "pod disappeared" });
        }
      }
    };

    // k8s watches expire routinely; re-arm on clean close so a healthy
    // long-lived session (TTL up to 1h) isn't failed by a watch rollover.
    const armWatch = async (): Promise<void> => {
      if (finished) return;
      try {
        const req = await kube.watch.watch(
          `/api/v1/namespaces/${ns}/pods`,
          { fieldSelector: `metadata.name=${podName}` },
          (type: string, obj: unknown) => handlePhase(obj),
          () => {
            if (finished) return;
            void reconcileOnce().then(() => {
              if (!finished) void armWatch();
            });
          },
        );
        abortWatch = () => {
          try {
            (req as { abort?: () => void }).abort?.();
          } catch {
            /* ignore */
          }
        };
      } catch (err) {
        if (!runningSeen) {
          clearStartDeadline();
          rejectRunning(new Error(`failed to watch pod: ${msg(err)}`));
        } else if (!finished) {
          setTimeout(() => void armWatch(), WATCH_REARM_DELAY_MS).unref?.();
        }
      }
    };

    startDeadline = setTimeout(() => {
      if (!runningSeen && !finished) {
        rejectRunning(new Error("pod did not reach Running within the start deadline"));
      }
    }, START_DEADLINE_MS);
    startDeadline.unref?.();

    await armWatch();

    try {
      await running;
    } catch (err) {
      clearStartDeadline();
      abortWatch();
      bundleStore.drop(spec.sessionId);
      await deletePod(kube, ns, podName);
      throw new SessionStartError("start_failed", "start", `pod failed to start: ${msg(err)}`, msg(err));
    }

    // Attach a PTY to the running container: stdout → onOutput, stdin ← writes.
    try {
      const ws = await kube.attach.attach(ns, podName, "session", stdout, null, stdin, true);
      socket = ws as unknown as ResizableSocket;
    } catch (err) {
      // Attach failure isn't fatal — status still flows; surface the degraded PTY.
      spec.onOutput(appName, Buffer.from(`\r\n[runner] failed to attach PTY: ${msg(err)}\r\n`), "tty");
    }

    if (config.sessionIngressBaseDomain && app.ports.length > 0) {
      await createIngress(deps, spec.sessionId, podName, podUid, app.ports).catch((err) => {
        spec.onOutput(appName, Buffer.from(`\r\n[runner] failed to create ingress: ${msg(err)}\r\n`), "tty");
      });
    }

    // The Running watch event usually carries `podIP`; if it lagged, read the
    // pod once and cache it — shared by the debug relay and the reachability check.
    const resolvePodIP = async (): Promise<string | undefined> => {
      if (podIP) return podIP;
      podIP = await kube.core
        .readNamespacedPod({ name: podName, namespace: ns })
        .then((p) => podStatus(p)?.podIP)
        .catch(() => undefined);
      return podIP;
    };

    // When inspect is on, relay the workload's in-pod kernel debug stream out
    // over `onDebug`. Reached by pod IP over the cluster network — the inspect
    // port is never published via Service/Ingress.
    if (spec.inspect) {
      const ip = await resolvePodIP();
      if (ip) {
        void relayDebugStream({
          url: `http://${ip}:${INSPECT_PORT}/events`,
          onFrame: (frame) => spec.onDebug(appName, frame),
          signal: debugAbort.signal,
        });
      } else {
        spec.onOutput(appName, Buffer.from("\r\n[runner] debug stream unavailable: pod IP unknown\r\n"), "tty");
      }
    }

    // Reachability check: a workload bound to 127.0.0.1 (or listening on the
    // wrong port) is unreachable on the pod network and surfaces only as a
    // downstream 502. Watch each advertised tcp port from the runner and report
    // per-port state to studio's endpoint badge. Background; finish() aborts it.
    const tcpPorts = app.ports.filter((p) => p.protocol === "tcp").map((p) => p.port);
    if (tcpPorts.length > 0) {
      void (async () => {
        const ip = await resolvePodIP();
        if (reachAbort.signal.aborted) return;
        if (!ip) {
          // Couldn't resolve the pod IP to probe — report unverified rather than
          // leaving the badge spinning forever.
          for (const port of tcpPorts) spec.onReachability(appName, port, "unreachable");
          return;
        }
        await watchReachability({
          host: ip,
          ports: tcpPorts,
          onState: (port, state) => spec.onReachability(appName, port, state),
          signal: reachAbort.signal,
        });
      })();
    }

    // `flipRunning` already announced `running` from the watch's Running
    // transition (which `await running` above waited on).
    return {
      writeStdin(app, bytes) {
        try {
          stdin.write(Buffer.from(bytes));
        } catch {
          /* stream ended */
        }
      },
      resize(app, cols, rows) {
        if (!socket) return;
        try {
          const payload = Buffer.from(JSON.stringify({ Width: cols, Height: rows }));
          socket.send(Buffer.concat([Buffer.from([RESIZE_CHANNEL]), payload]));
        } catch {
          /* socket gone */
        }
      },
      done,
      async stop() {
        // The route sets userStopped before calling stop(), so the watch (or
        // this finish) classifies the kill as `stopped`, not `failed`.
        await deletePod(kube, ns, podName);
        finish({ kind: "stopped" });
      },
    };
  }

  async function reapOrphans(): Promise<void> {
    // The session registry is in-memory; on boot a prior process's pods are
    // orphaned. Delete everything we own by label. Errors propagate to the
    // caller (the server logs them) rather than being swallowed.
    const list = await kube.core.listNamespacedPod({
      namespace: ns,
      labelSelector: `app.kubernetes.io/managed-by=${config.managedByLabel}`,
    });
    const failures: string[] = [];
    for (const item of list.items ?? []) {
      const name = item.metadata?.name;
      if (!name) continue;
      try {
        await deletePod(kube, ns, name);
      } catch (err) {
        failures.push(`${name}: ${msg(err)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`failed to reap ${failures.length} orphan pod(s): ${failures.join("; ")}`);
    }
  }

  return { probe, start, reapOrphans };
}

async function createIngress(
  deps: K8sBackendDeps,
  sessionId: string,
  podName: string,
  podUid: string,
  ports: PortMapping[],
): Promise<void> {
  const { kube, config } = deps;
  const ns = config.sessionNamespace;
  const service = buildSessionService(config, sessionId, podName, podUid, ports);
  await kube.core.createNamespacedService({ namespace: ns, body: service });
  const { ingress } = buildSessionIngress(
    config,
    sessionId,
    service.metadata!.name!,
    podName,
    podUid,
    ports,
  );
  // No tcp ports → no HTTP-routable rules; the Service still exists for any udp.
  if (!ingress.spec?.rules?.length) return;
  await kube.networking.createNamespacedIngress({ namespace: ns, body: ingress });
}

async function clusterReachable(kube: KubeClient): Promise<boolean> {
  try {
    await kube.core.listNamespace();
    return true;
  } catch {
    return false;
  }
}
