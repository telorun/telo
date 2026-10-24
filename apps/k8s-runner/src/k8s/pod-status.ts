import type { V1ContainerState, V1ContainerStatus, V1Pod } from "@kubernetes/client-node";

import { statusCode } from "./api-error.js";
import type { KubeClient } from "./client.js";

/**
 * Reading a Pod's status: pure functions over a pod read or a watch payload,
 * plus the deletes every path performs, so no two paths disagree about what
 * "failed" means.
 */

export function podStatus(obj: unknown): V1Pod["status"] | undefined {
  return (obj as V1Pod | undefined)?.status;
}

export function podPhase(obj: unknown): string | undefined {
  return podStatus(obj)?.phase;
}

/** A coming-up message for the studio feed while the Pod is still scheduling /
 *  pulling / preparing its storage / creating containers; undefined once running. */
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
      return "Preparing the session";
    case "ErrImagePull":
    case "ImagePullBackOff":
      return "Pulling image";
    default:
      return reason;
  }
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

/** The first container of the pod that has terminated, as the session's
 *  infrastructure failure names it. A container ending is never a run outcome:
 *  every container of a session pod is meant to run as long as the pod. */
export function endedContainer(obj: unknown): string | undefined {
  for (const cs of podStatus(obj)?.containerStatuses ?? []) {
    const term = cs.state?.terminated;
    if (!term) continue;
    const reason = term.reason ? `${term.reason}, ` : "";
    return `container '${cs.name}' ended (${reason}exit code ${term.exitCode ?? "unknown"})`;
  }
  return undefined;
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
  return statusCode(err) === 404;
}

/** A name-already-taken rejection — what makes a create idempotent by falling
 *  through to a replace. Reads the status through `statusCode` like every other
 *  classification here, so an `ECONNREFUSED` or a `DOMException`'s legacy number
 *  in `code` cannot be mistaken for one. */
export function isConflict(err: unknown): boolean {
  return statusCode(err) === 409;
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

const POD_GONE_POLL_MS = 500;
const POD_GONE_DEADLINE_MS = 120_000;

/**
 * Delete a pod and wait until the API no longer has it. A session's next pod
 * mounts the same ReadWriteOnce volume, and the agent's SQLite state must never
 * have two writers, so a replacement is created only once the old pod is gone.
 */
export async function deletePodAndWait(kube: KubeClient, ns: string, name: string): Promise<void> {
  await deletePod(kube, ns, name);
  const deadline = Date.now() + POD_GONE_DEADLINE_MS;
  for (;;) {
    try {
      await kube.core.readNamespacedPod({ name, namespace: ns });
    } catch (err) {
      if (is404(err)) return;
      throw err;
    }
    if (Date.now() > deadline) {
      throw new Error(`pod '${name}' was still terminating ${POD_GONE_DEADLINE_MS / 1000}s after its deletion`);
    }
    await new Promise((resolve) => setTimeout(resolve, POD_GONE_POLL_MS).unref?.());
  }
}
