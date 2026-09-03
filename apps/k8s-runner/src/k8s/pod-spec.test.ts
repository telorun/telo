import { describe, expect, it } from "vitest";

import { loadK8sRunnerConfig } from "../config.js";
import { buildAppPod, buildSessionPod } from "./pod-spec.js";

const BASE_ENV = {
  RUNNER_SELF_URL: "http://k8s-runner.telo-runner.svc:8062",
};

describe("buildSessionPod", () => {
  const config = loadK8sRunnerConfig({ ...process.env, ...BASE_ENV });
  const pod = buildSessionPod({
    config,
    sessionId: "abc123",
    podName: "telo-run-abc123",
    entryRelativePath: "telo.yaml",
    env: { API_TOKEN: "tok" },
    ports: [{ port: 3000, protocol: "tcp" }],
    limits: config.limits,
    image: "telorun/node:0.30.1-slim",
    pullPolicy: "always",
    bundleUrl: "http://k8s-runner.telo-runner.svc:8062/internal/bundles/abc123?token=t",
    inspect: false,
  });
  const container = pod.spec!.containers[0];

  it("runs the picked kernel image under the requested pull policy", () => {
    expect(container.image).toBe("telorun/node:0.30.1-slim");
    expect(container.imagePullPolicy).toBe("Always");
  });

  it("resolves the module closure at boot into a writable cache", () => {
    // No prebuilt image means no baked deps: the cache has to be a mounted
    // emptyDir, and `telo run` has to be allowed to write it.
    expect(container.env).toContainEqual({ name: "TELO_CACHE_DIR", value: "/telo-cache" });
    expect(container.volumeMounts).toContainEqual({
      name: "telo-cache",
      mountPath: "/telo-cache",
    });
    expect(pod.spec!.volumes).toContainEqual({ name: "telo-cache", emptyDir: {} });
    expect(container.command).toEqual(["telo", "run", "/app/telo.yaml"]);
  });

  it("is given headroom to resolve a closure, not just to run one", () => {
    // The ceilings used to describe a pod that only RAN a prebuilt image (50m /
    // 100Mi / 512Mi). It now downloads, unpacks and resolves the closure itself,
    // into an emptyDir charged against ephemeral-storage — the old numbers were
    // an OOMKill and an eviction for the ordinary case. Asserted against the
    // app-session ceilings, which is the tier the equivalent watch container
    // already ran under.
    expect(container.resources?.limits?.memory).toBe(config.appLimits.memory);
    expect(container.resources?.limits?.cpu).toBe(config.appLimits.cpu);
    expect(container.resources?.limits?.["ephemeral-storage"]).toBe(
      config.appLimits.ephemeralStorage,
    );
  });

  it("delivers the body over the initContainer and keeps the rootfs read-only", () => {
    const init = pod.spec!.initContainers![0];
    expect(init.args?.[0]).toContain("/internal/bundles/abc123?token=t");
    expect(container.securityContext).toMatchObject({ readOnlyRootFilesystem: true });
    expect(pod.spec!.automountServiceAccountToken).toBe(false);
  });
});

describe("buildAppPod", () => {
  const config = loadK8sRunnerConfig({ ...process.env, ...BASE_ENV });
  const pod = buildAppPod({
    config,
    sessionId: "abc123",
    podName: "telo-run-abc123",
    env: { SERVICE_TOKEN: "tok-operator" },
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
