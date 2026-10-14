import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";

import type { V1NetworkPolicy, V1OwnerReference, V1Pod } from "@kubernetes/client-node";
import {
  SessionContainerNotFound,
  type SessionContainerEngine,
  type SessionContainerOutput,
} from "@telorun/runner-core";

import type { K8sRunnerConfig } from "../config.js";
import { apiReason, withCause } from "./api-error.js";
import type { KubeClient } from "./client.js";
import { podOwnerRef } from "./routing/session-service.js";
import {
  buildSessionContainerPod,
  buildSessionContainerPolicies,
  POLICY_DIRECTIONS,
  SESSION_CONTAINER_NAME,
  SESSION_POD_LABEL,
  sessionContainerPolicyName,
} from "./session-container-pod.js";
import { deletePod, is404, isConflict, podPhase, podStatus } from "./pod-status.js";

/** How long a container may take to start — its image pulled by the node — before
 *  the start is abandoned. The client's own startup timeout usually ends it first. */
const START_DEADLINE_MS = 180_000;
const POLL_MS = 500;
/** Waiting reasons that will not clear on their own. */
const STUCK = new Set([
  "ErrImageNeverPull",
  "ImagePullBackOff",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
]);

/**
 * A session's containers as pods in the session namespace, under its
 * `restricted` posture, owned by the session's pod and reached at the pod's IP.
 * The node pulls an image when the pod starts, so an image is reported held and
 * a pull asked for is already done. Logs are the pod log API's.
 */
export function createKubernetesSessionContainerEngine(deps: {
  kube: KubeClient;
  config: K8sRunnerConfig;
}): SessionContainerEngine {
  const { kube, config } = deps;
  const ns = config.sessionNamespace;

  async function readPod(id: string): Promise<V1Pod> {
    try {
      return await kube.core.readNamespacedPod({ name: id, namespace: ns });
    } catch (err) {
      if (is404(err)) throw new SessionContainerNotFound(id);
      throw failure(err, "could not read the container's pod");
    }
  }

  /** The session's live pod, which owns everything the session starts. */
  async function sessionOwner(sessionId: string): Promise<V1OwnerReference> {
    let pods: V1Pod[];
    try {
      pods =
        (
          await kube.core.listNamespacedPod({
            namespace: ns,
            labelSelector: `${SESSION_POD_LABEL}=${sessionId}`,
          })
        ).items ?? [];
    } catch (err) {
      throw failure(err, "could not find the session's pod");
    }
    const live = pods.find(
      (pod) => !pod.metadata?.deletionTimestamp && podPhase(pod) === "Running",
    );
    if (!live?.metadata?.name || !live.metadata.uid) {
      throw new Error(`session '${sessionId}' has no running pod to own its containers`);
    }
    return podOwnerRef(live.metadata.name, live.metadata.uid);
  }

  /** Each policy present and owned by the session's current pod. A watch
   *  session's pod is replaced on a resume, and a policy left owned by the old
   *  one would be collected with it. */
  async function ensurePolicies(sessionId: string, owner: V1OwnerReference): Promise<void> {
    for (const policy of buildSessionContainerPolicies({ config, sessionId, owner })) {
      const name = policy.metadata!.name!;
      let existing: V1NetworkPolicy | undefined;
      try {
        existing = await kube.networking.readNamespacedNetworkPolicy({ name, namespace: ns });
      } catch (err) {
        if (!is404(err)) throw failure(err, "could not read the session's network policy");
      }
      try {
        if (!existing) {
          await kube.networking.createNamespacedNetworkPolicy({ namespace: ns, body: policy });
        } else if (existing.metadata?.ownerReferences?.[0]?.uid !== owner.uid) {
          await kube.networking.replaceNamespacedNetworkPolicy({
            name,
            namespace: ns,
            body: {
              ...policy,
              metadata: { ...policy.metadata, resourceVersion: existing.metadata?.resourceVersion },
            },
          });
        }
      } catch (err) {
        // Another create for the same session got there first.
        if (isConflict(err)) continue;
        throw failure(err, "could not write the session's network policy");
      }
    }
  }

  return {
    async ping() {
      try {
        await kube.core.readNamespace({ name: ns });
      } catch (err) {
        throw failure(err, "the session namespace cannot be read");
      }
    },

    async hasImage() {
      return true;
    },

    async pullImage() {},

    async create(sessionId, spec) {
      const owner = await sessionOwner(sessionId);
      const name = `telo-ctr-${sessionId}-${randomBytes(3).toString("hex")}`;
      const pod = buildSessionContainerPod({ config, sessionId, name, spec, owner });
      await ensurePolicies(sessionId, owner);
      try {
        await kube.core.createNamespacedPod({ namespace: ns, body: pod });
      } catch (err) {
        throw failure(err, "could not create the container's pod");
      }
      return name;
    },

    async start(sessionId, id, signal) {
      const deadline = Date.now() + START_DEADLINE_MS;
      for (;;) {
        const pod = await readPod(id);
        const status = podStatus(pod)?.containerStatuses?.find(
          (container) => container.name === SESSION_CONTAINER_NAME,
        );
        if (status?.state?.running || status?.state?.terminated) return;
        if (podPhase(pod) === "Failed" || podPhase(pod) === "Succeeded") return;
        const waiting = status?.state?.waiting;
        if (waiting?.reason && STUCK.has(waiting.reason)) {
          throw new Error(
            `the container could not start: ${waiting.reason}` +
              (waiting.message ? `: ${waiting.message}` : ""),
          );
        }
        if (Date.now() > deadline) {
          throw new Error(
            `the container did not start within ${START_DEADLINE_MS / 1000}s` +
              (waiting?.reason ? ` (${waiting.reason})` : ""),
          );
        }
        if (signal.aborted) throw new Error("the start was abandoned by its caller");
        await sleep(POLL_MS);
      }
    },

    async inspect(sessionId, id) {
      const pod = await readPod(id);
      const status = podStatus(pod)?.containerStatuses?.find(
        (container) => container.name === SESSION_CONTAINER_NAME,
      );
      const terminated = status?.state?.terminated;
      const address = podStatus(pod)?.podIP;
      return {
        running: Boolean(status?.state?.running),
        exitCode: terminated ? (terminated.exitCode ?? null) : null,
        ...(address ? { address } : {}),
      };
    },

    async logs(sessionId, id, options, signal) {
      const output = new PassThrough();
      let request: AbortController;
      try {
        request = await kube.log.log(ns, id, SESSION_CONTAINER_NAME, output, {
          follow: options.follow,
          ...(options.tail !== undefined ? { tailLines: options.tail } : {}),
        });
      } catch (err) {
        if (is404(err)) throw new SessionContainerNotFound(id);
        throw failure(err, "could not read the container's logs");
      }
      signal.addEventListener(
        "abort",
        () => {
          request.abort();
          output.end();
        },
        { once: true },
      );
      return chunksOf(output);
    },

    async remove(sessionId, id) {
      try {
        await deletePod(kube, ns, id);
      } catch (err) {
        throw failure(err, "could not delete the container's pod");
      }
    },

    // A run session's pod is kept after it exits, so its policies would
    // otherwise outlive the session as long as the pod does.
    async endSession(sessionId) {
      for (const direction of POLICY_DIRECTIONS) {
        try {
          await kube.networking.deleteNamespacedNetworkPolicy({
            name: sessionContainerPolicyName(sessionId, direction),
            namespace: ns,
          });
        } catch (err) {
          if (!is404(err)) throw failure(err, "could not delete the session's network policy");
        }
      }
    },
  };
}

/** The pod log API does not separate the streams, so everything is stdout. */
async function* chunksOf(source: AsyncIterable<Buffer | string>): AsyncIterable<SessionContainerOutput> {
  for await (const chunk of source) {
    yield { stream: "stdout", data: typeof chunk === "string" ? Buffer.from(chunk) : chunk };
  }
}

/** A Kubernetes API failure, told as what was refused — never the API's own
 *  message, which names cluster identities; the exception rides as `cause`. */
function failure(err: unknown, action: string): Error {
  return withCause(new Error(`${action}: ${apiReason(err)}`), err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}
