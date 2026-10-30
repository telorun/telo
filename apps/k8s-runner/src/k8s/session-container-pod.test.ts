import { SessionContainerFieldRefused, type SessionContainerSpec } from "@telorun/runner-core";
import { describe, expect, it } from "vitest";

import { loadK8sRunnerConfig } from "../config.js";
import { podOwnerRef } from "./routing/session-service.js";
import { buildSessionContainerPod, buildSessionContainerPolicies } from "./session-container-pod.js";

const config = {
  ...loadK8sRunnerConfig({
    RUNNER_SUPERVISOR_IMAGE: "telorun/k8s-runner:test",
    RUNNER_STATE_DIR: "/var/lib/telo-runner",
  }),
  sessionContainerResources: {
    limits: { cpu: "1", memory: "1Gi", ephemeralStorage: "2Gi" },
    requests: { cpu: "250m", memory: "256Mi" },
  },
};
const owner = podOwnerRef("telo-run-abc", "uid-1");

const SPEC: SessionContainerSpec = {
  image: "pgvector/pgvector:pg18",
  cmd: ["postgres", "-c", "fsync=off"],
  env: ["POSTGRES_PASSWORD=pa=ss"],
  user: "999:999",
  ports: [5432],
  labels: { "run.telo.session": "abc", "run.telo.container.expires": "1760000000" },
};

function pod(spec: SessionContainerSpec = SPEC) {
  return buildSessionContainerPod({ config, sessionId: "abc", name: "telo-ctr-abc-1", spec, owner });
}

describe("a session container's pod", () => {
  it("runs under the restricted posture as the numeric user asked for", () => {
    const built = pod();
    expect(built.spec!.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 999,
      runAsGroup: 999,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(built.spec!.automountServiceAccountToken).toBe(false);
    expect(built.spec!.containers[0]!.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      capabilities: { drop: ["ALL"] },
    });
  });

  it.each(["root", "0", "0:0", "postgres", "999:postgres"])("refuses user %s naming User", (user) => {
    expect(() => pod({ ...SPEC, user })).toThrow(SessionContainerFieldRefused);
  });

  it("runs the container asked for, binding no host port", () => {
    const container = pod().spec!.containers[0]!;
    expect(container).toMatchObject({
      image: "pgvector/pgvector:pg18",
      args: ["postgres", "-c", "fsync=off"],
      env: [{ name: "POSTGRES_PASSWORD", value: "pa=ss" }],
      ports: [{ containerPort: 5432, protocol: "TCP" }],
      resources: {
        limits: { cpu: "1", memory: "1Gi", "ephemeral-storage": "2Gi" },
        requests: { cpu: "250m", memory: "256Mi" },
      },
    });
    expect(container.command).toBeUndefined();
  });

  it("is owned by the session's pod and never selected by the session's Service", () => {
    const { metadata } = pod();
    expect(metadata!.ownerReferences).toEqual([owner]);
    expect(metadata!.labels).toEqual({
      "app.kubernetes.io/managed-by": "telo-k8s-runner",
      "run.telo.session": "abc",
    });
  });
});

describe("a session's container policies", () => {
  it("admit the session's pods to its containers and nothing else", () => {
    const [ingress, egress] = buildSessionContainerPolicies({ config, sessionId: "abc", owner });
    expect(ingress!.spec).toEqual({
      podSelector: { matchLabels: { "run.telo.session": "abc" } },
      policyTypes: ["Ingress"],
      ingress: [{ _from: [{ podSelector: { matchLabels: { "telo.run/session-id": "abc" } } }] }],
    });
    expect(egress!.spec).toEqual({
      podSelector: { matchLabels: { "telo.run/session-id": "abc" } },
      policyTypes: ["Egress"],
      egress: [{ to: [{ podSelector: { matchLabels: { "run.telo.session": "abc" } } }] }],
    });
    expect([ingress!.metadata!.ownerReferences, egress!.metadata!.ownerReferences]).toEqual([
      [owner],
      [owner],
    ]);
  });
});
