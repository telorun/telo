import type { V1Pod } from "@kubernetes/client-node";
import { SessionContainerNotFound } from "@telorun/runner-core";
import { describe, expect, it } from "vitest";

import { loadK8sRunnerConfig } from "../config.js";
import type { KubeClient } from "./client.js";
import { createKubernetesSessionContainerEngine } from "./session-container-engine.js";

const config = loadK8sRunnerConfig({ RUNNER_SELF_URL: "http://k8s-runner.telo-runner.svc:8062" });

const SPEC = {
  image: "pgvector/pgvector:pg18",
  env: [],
  user: "999:999",
  ports: [5432],
  labels: { "run.telo.session": "abc" },
};

function sessionPod(name: string, uid: string, extra: Partial<V1Pod["metadata"]> = {}): V1Pod {
  return { metadata: { name, uid, ...extra }, status: { phase: "Running" } };
}

function fakeKube(pods: Record<string, V1Pod>, sessionPods: V1Pod[] = [], existingPolicies: string[] = []) {
  const created: V1Pod[] = [];
  const policies: string[] = [];
  const deletedPolicies: string[] = [];
  const notFound = () => Object.assign(new Error("not found"), { code: 404 });
  const kube = {
    core: {
      readNamespacedPod: async ({ name }: { name: string }) => {
        if (!pods[name]) throw notFound();
        return pods[name];
      },
      listNamespacedPod: async () => ({ items: sessionPods }),
      createNamespacedPod: async ({ body }: { body: V1Pod }) => {
        created.push(body);
        return body;
      },
    },
    networking: {
      readNamespacedNetworkPolicy: async () => {
        throw notFound();
      },
      createNamespacedNetworkPolicy: async ({ body }: { body: { metadata: { name: string } } }) => {
        policies.push(body.metadata.name);
        return body;
      },
      deleteNamespacedNetworkPolicy: async ({ name }: { name: string }) => {
        if (!existingPolicies.includes(name)) throw notFound();
        deletedPolicies.push(name);
        return {};
      },
    },
  } as unknown as KubeClient;
  return { kube, created, policies, deletedPolicies };
}

describe("the kubernetes session container engine", () => {
  it("starts a pod owned by the session's live pod, behind the session's two policies", async () => {
    const { kube, created, policies } = fakeKube({}, [
      sessionPod("telo-watch-abc-old", "uid-old", { deletionTimestamp: new Date() }),
      sessionPod("telo-watch-abc-new", "uid-new"),
    ]);
    const engine = createKubernetesSessionContainerEngine({ kube, config });
    const id = await engine.create("abc", SPEC);
    expect(id).toMatch(/^telo-ctr-abc-[0-9a-f]{6}$/);
    expect(created[0]!.metadata!.ownerReferences![0]!.uid).toBe("uid-new");
    expect(policies).toEqual(["telo-ctr-abc-ingress", "telo-ctr-abc-egress"]);
  });

  it("answers a running container with its pod's address", async () => {
    const { kube } = fakeKube({
      "telo-ctr-abc-1": {
        status: {
          phase: "Running",
          podIP: "10.244.0.12",
          containerStatuses: [
            { name: "container", image: "", imageID: "", ready: true, restartCount: 0, state: { running: {} } },
          ],
        },
      },
    });
    const engine = createKubernetesSessionContainerEngine({ kube, config });
    expect(await engine.inspect("abc", "telo-ctr-abc-1")).toEqual({
      running: true,
      exitCode: null,
      address: "10.244.0.12",
    });
  });

  it("fails a start whose container cannot run, with the kubelet's reason", async () => {
    const { kube } = fakeKube({
      "telo-ctr-abc-1": {
        status: {
          phase: "Pending",
          containerStatuses: [
            {
              name: "container",
              image: "",
              imageID: "",
              ready: false,
              restartCount: 0,
              state: { waiting: { reason: "ImagePullBackOff", message: "Back-off pulling image" } },
            },
          ],
        },
      },
    });
    const engine = createKubernetesSessionContainerEngine({ kube, config });
    await expect(engine.start("abc", "telo-ctr-abc-1", new AbortController().signal)).rejects.toThrow(
      "the container could not start: ImagePullBackOff: Back-off pulling image",
    );
  });

  it("deletes the session's two policies when the session ends, one already gone included", async () => {
    const { kube, deletedPolicies } = fakeKube({}, [], ["telo-ctr-abc-ingress"]);
    const engine = createKubernetesSessionContainerEngine({ kube, config });
    await engine.endSession!("abc");
    expect(deletedPolicies).toEqual(["telo-ctr-abc-ingress"]);
  });

  it("answers a pod that is gone as a container that is gone", async () => {
    const engine = createKubernetesSessionContainerEngine({ kube: fakeKube({}).kube, config });
    await expect(engine.inspect("abc", "telo-ctr-abc-9")).rejects.toBeInstanceOf(SessionContainerNotFound);
  });
});
