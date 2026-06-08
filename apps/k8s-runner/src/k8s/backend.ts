import { PassThrough, Writable } from "node:stream";

import type {
  AvailabilityReport,
  BackendSession,
  BackendStartSpec,
  ProbeConfig,
  RunStatus,
  RunnerBackend,
} from "@telorun/runner-core";
import { SessionStartError } from "@telorun/runner-core";
import type { V1ContainerState, V1ContainerStatus, V1Pod } from "@kubernetes/client-node";

import type { K8sRunnerConfig } from "../config.js";
import type { BundleStore } from "../bundle-store.js";
import { clampLimits } from "../limits.js";
import type { KubeClient } from "./client.js";
import { buildSessionPod } from "./pod-spec.js";
import { ensureSessionImage } from "./image-build.js";
import { buildSessionIngress, buildSessionService, endpointsFor } from "./ingress.js";

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

  async function probe(_probe: ProbeConfig): Promise<AvailabilityReport> {
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
    const podName = `telo-run-${spec.sessionId}`;
    // The /v1 contract carries no per-request limits yet, so `requested` is
    // undefined and the configured ceiling is always the effective limit. When
    // a control plane begins passing limits, plumb them here — the clamp is
    // already min(requested, ceiling).
    const limits = clampLimits(config.limits, undefined);

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
        entryRelativePath: spec.entryRelativePath,
        baseImage: spec.config.image || config.defaultImage,
      },
    );

    const pod = buildSessionPod({
      config,
      sessionId: spec.sessionId,
      podName,
      entryRelativePath: spec.entryRelativePath,
      env: spec.env,
      ports: spec.ports,
      limits,
      image,
    });

    let podUid: string;
    try {
      const created = await kube.core.createNamespacedPod({ namespace: ns, body: pod });
      podUid = created.metadata?.uid ?? "";
    } catch (err) {
      throw new SessionStartError("start_failed", "create", `failed to create pod: ${msg(err)}`, msg(err));
    }

    let finished = false;
    let runningSeen = false;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    let socket: ResizableSocket | undefined;
    let abortWatch: () => void = () => {};
    let startDeadline: NodeJS.Timeout | undefined;

    const stdin = new PassThrough();
    const stdout = new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (chunk?.byteLength) spec.onOutput(Buffer.from(chunk));
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
      spec.onStatus(status);
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      resolveDone();
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
      if (phase === "Running" && !runningSeen) {
        runningSeen = true;
        clearStartDeadline();
        resolveRunning();
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
          (_type: string, obj: unknown) => handlePhase(obj),
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
      await deletePod(kube, ns, podName);
      throw new SessionStartError("start_failed", "start", `pod failed to start: ${msg(err)}`, msg(err));
    }

    // Attach a PTY to the running container: stdout → onOutput, stdin ← writes.
    try {
      const ws = await kube.attach.attach(ns, podName, "session", stdout, null, stdin, true);
      socket = ws as unknown as ResizableSocket;
    } catch (err) {
      // Attach failure isn't fatal — status still flows; surface the degraded PTY.
      spec.onOutput(Buffer.from(`\r\n[runner] failed to attach PTY: ${msg(err)}\r\n`));
    }

    if (config.ingressBaseDomain && spec.ports.length > 0) {
      await createIngress(deps, spec.sessionId, podName, podUid, spec.ports).catch((err) => {
        spec.onOutput(Buffer.from(`\r\n[runner] failed to create ingress: ${msg(err)}\r\n`));
      });
    }

    spec.onStatus({ kind: "running", endpoints: endpointsFor(config, spec.sessionId, spec.ports) });

    return {
      writeStdin(bytes) {
        try {
          stdin.write(Buffer.from(bytes));
        } catch {
          /* stream ended */
        }
      },
      resize(cols, rows) {
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
  ports: BackendStartSpec["ports"],
): Promise<void> {
  const { kube, config } = deps;
  const ns = config.sessionNamespace;
  const service = buildSessionService(config, sessionId, podName, podUid, ports);
  await kube.core.createNamespacedService({ namespace: ns, body: service });
  const primary = ports[0]!;
  const { ingress } = buildSessionIngress(
    config,
    sessionId,
    service.metadata!.name!,
    podName,
    podUid,
    primary.port,
  );
  await kube.networking.createNamespacedIngress({ namespace: ns, body: ingress });
}

async function deletePod(kube: KubeClient, ns: string, name: string): Promise<void> {
  try {
    await kube.core.deleteNamespacedPod({ name, namespace: ns, gracePeriodSeconds: 0 });
  } catch (err) {
    // 404 = already gone (natural exit + GC). Anything else is a real failure.
    if (!is404(err)) throw err;
  }
}

async function clusterReachable(kube: KubeClient): Promise<boolean> {
  try {
    await kube.core.listNamespace();
    return true;
  } catch {
    return false;
  }
}

function podStatus(obj: unknown): V1Pod["status"] | undefined {
  return (obj as V1Pod | undefined)?.status;
}

function podPhase(obj: unknown): string | undefined {
  return podStatus(obj)?.phase;
}

function terminalStatus(obj: unknown, userStopped: boolean): RunStatus {
  if (userStopped) return { kind: "stopped" };
  const phase = podPhase(obj);
  if (phase === "Succeeded") return { kind: "exited", code: containerExitCode(obj) ?? 0 };
  return { kind: "failed", message: podFailureMessage(obj) };
}

// Exit code of the main session container — used to report a clean exit.
function containerExitCode(obj: unknown): number | null {
  const term = podStatus(obj)?.containerStatuses?.[0]?.state?.terminated;
  return typeof term?.exitCode === "number" ? term.exitCode : null;
}

const MAX_FAILURE_DETAIL = 500;

/**
 * Builds an actionable failure message from a terminal Pod status. Init
 * containers are inspected first: a failed init container leaves the main
 * container unstarted, so reading only `containerStatuses` would fall through
 * to the bare "pod failed". For prebuilt session pods the common failure is the
 * main container itself (image pull, OOM, a non-zero exit).
 */
export function podFailureMessage(obj: unknown): string {
  const status = podStatus(obj);
  const fromContainer = firstContainerProblem(status);
  if (fromContainer) return fromContainer;
  if (status?.message) return truncateDetail(status.message);
  if (status?.reason) return status.reason;
  return "pod failed";
}

function firstContainerProblem(status: V1Pod["status"] | undefined): string | undefined {
  const groups: Array<[string, V1ContainerStatus[] | undefined]> = [
    ["init container", status?.initContainerStatuses],
    ["container", status?.containerStatuses],
  ];
  for (const [label, statuses] of groups) {
    for (const cs of statuses ?? []) {
      const problem = containerStateProblem(cs.state) ?? containerStateProblem(cs.lastState);
      if (problem) return `${label} "${cs.name}" ${problem}`;
    }
  }
  return undefined;
}

function containerStateProblem(state: V1ContainerState | undefined): string | undefined {
  const term = state?.terminated;
  if (term && term.exitCode !== 0) {
    const reason = term.reason ? `${term.reason} ` : "";
    const detail = term.message ? `: ${truncateDetail(term.message)}` : "";
    return `failed: ${reason}(exit code ${term.exitCode ?? "unknown"})${detail}`;
  }
  const waiting = state?.waiting;
  if (waiting?.reason && isBlockingWaitReason(waiting.reason)) {
    const detail = waiting.message ? `: ${truncateDetail(waiting.message)}` : "";
    return `waiting: ${waiting.reason}${detail}`;
  }
  return undefined;
}

// Benign transient reasons the kubelet reports while a Pod is still coming up.
function isBlockingWaitReason(reason: string): boolean {
  return reason !== "PodInitializing" && reason !== "ContainerCreating";
}

function truncateDetail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_FAILURE_DETAIL ? `${trimmed.slice(0, MAX_FAILURE_DETAIL)}…` : trimmed;
}

function is404(err: unknown): boolean {
  const e = err as { statusCode?: number; code?: number; response?: { statusCode?: number } };
  return e?.statusCode === 404 || e?.code === 404 || e?.response?.statusCode === 404;
}

function msg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
