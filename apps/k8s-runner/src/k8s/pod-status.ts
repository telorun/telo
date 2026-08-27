import type { V1ContainerState, V1ContainerStatus, V1Pod } from "@kubernetes/client-node";
import type { RunStatus } from "@telorun/runner-core";

import type { KubeClient } from "./client.js";

/**
 * Reading a Pod's status — shared by the run-session and watch-session paths.
 * Pure functions over the watch payload plus the one delete that both perform;
 * extracted so the two lifecycles cannot disagree about what "failed" means or
 * which container's exit code counts.
 */

export function podStatus(obj: unknown): V1Pod["status"] | undefined {
  return (obj as V1Pod | undefined)?.status;
}

export function podPhase(obj: unknown): string | undefined {
  return podStatus(obj)?.phase;
}

/** A coming-up message for the studio feed while the Pod is still scheduling /
 *  pulling / delivering the body / creating the container; undefined once running. */
export function provisionMessage(obj: unknown): string | undefined {
  const status = podStatus(obj);
  if (status?.phase !== "Pending") return undefined;
  const containers = [
    ...(status.initContainerStatuses ?? []),
    ...(status.containerStatuses ?? []),
  ];
  for (const cs of containers) {
    const reason = cs.state?.waiting?.reason;
    if (reason) return humanizeWaitReason(reason);
  }
  return "Scheduling";
}

function humanizeWaitReason(reason: string): string {
  switch (reason) {
    case "ContainerCreating":
      return "Creating container";
    case "PodInitializing":
      return "Delivering application";
    case "ErrImagePull":
    case "ImagePullBackOff":
      return "Pulling image";
    default:
      return reason;
  }
}

export function terminalStatus(obj: unknown, userStopped: boolean): RunStatus {
  if (userStopped) return { kind: "stopped" };
  const phase = podPhase(obj);
  if (phase === "Succeeded") return { kind: "exited", code: containerExitCode(obj) ?? 0 };
  return { kind: "failed", message: podFailureMessage(obj) };
}

// Exit code of the main session container — used to report a clean exit.
export function containerExitCode(obj: unknown): number | null {
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

export async function deletePod(kube: KubeClient, ns: string, name: string): Promise<void> {
  try {
    await kube.core.deleteNamespacedPod({ name, namespace: ns, gracePeriodSeconds: 0 });
  } catch (err) {
    // 404 = already gone (natural exit + GC). Anything else is a real failure.
    if (!is404(err)) throw err;
  }
}

export function is404(err: unknown): boolean {
  const e = err as { statusCode?: number; code?: number; response?: { statusCode?: number } };
  return e?.statusCode === 404 || e?.code === 404 || e?.response?.statusCode === 404;
}

export function msg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
