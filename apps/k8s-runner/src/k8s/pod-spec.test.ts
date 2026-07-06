import { describe, expect, it } from "vitest";

import { loadK8sRunnerConfig } from "../config.js";
import { buildAppPod } from "./pod-spec.js";

const BASE_ENV = {
  RUNNER_SELF_URL: "http://k8s-runner.telo-runner.svc:8062",
  RUNNER_IMAGE_REPOSITORY: "registry.telo-runner.svc:5000/telo-sessions",
};

describe("buildAppPod", () => {
  const config = loadK8sRunnerConfig({ ...process.env, ...BASE_ENV });
  const pod = buildAppPod({
    config,
    sessionId: "abc123",
    podName: "telo-run-abc123",
    env: { SERVICE_TOKEN: "tok-operator", TELO_REGISTRY_URL: "https://registry.telo.run" },
    ports: [{ port: 8080, protocol: "tcp" }],
    limits: config.appLimits,
    image: "acme/tool:1",
    pullPolicy: "always",
  });

  it("runs the catalog image's own entrypoint — no build, no bundle initContainer", () => {
    const container = pod.spec!.containers[0];
    expect(pod.spec!.initContainers).toBeUndefined();
    expect(container.image).toBe("acme/tool:1");
    expect(container.command).toBeUndefined();
    expect(container.imagePullPolicy).toBe("Always");
  });

  it("injects the merged env and declares the requested ports", () => {
    const container = pod.spec!.containers[0];
    expect(container.env).toContainEqual({ name: "SERVICE_TOKEN", value: "tok-operator" });
    expect(container.ports).toEqual([{ containerPort: 8080, protocol: "TCP" }]);
  });

  it("applies app ceilings and TTL, keeping non-write hardening on", () => {
    const container = pod.spec!.containers[0];
    expect(container.resources?.limits?.memory).toBe("512Mi");
    expect(pod.spec!.activeDeadlineSeconds).toBe(21600);
    expect(pod.spec!.automountServiceAccountToken).toBe(false);
    expect(pod.spec!.securityContext?.seccompProfile?.type).toBe("RuntimeDefault");
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    });
    // Write-path hardening is deliberately relaxed: the operator-curated image
    // owns its filesystem layout and user.
    expect(container.securityContext).not.toHaveProperty("readOnlyRootFilesystem");
    expect(pod.spec!.securityContext).not.toHaveProperty("runAsNonRoot");
  });

  it("labels the pod for orphan reaping like session pods", () => {
    expect(pod.metadata?.labels).toMatchObject({
      "app.kubernetes.io/managed-by": "telo-k8s-runner",
      "telo.run/session-id": "abc123",
    });
  });
});
