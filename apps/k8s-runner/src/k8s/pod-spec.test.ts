import type { V1Container } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

import { loadK8sRunnerConfig } from "../config.js";
import { clampLimits } from "../limits.js";
import { buildSessionPod, reservedPortsFor } from "./pod-spec.js";

const config = loadK8sRunnerConfig({
  RUNNER_SUPERVISOR_IMAGE: "telorun/k8s-runner:0.22.0",
  RUNNER_STATE_DIR: "/var/lib/telo-runner",
  RUNNER_IMAGE: "telorun/node:0.121.0-slim",
  RUNNER_MAX_CPU: "300m",
  RUNNER_APP_MAX_MEMORY: "1Gi",
});

const OPERATOR_KEY = "OPENAI_API_KEY";
const APPS = [
  { name: "web", entryRelativePath: "telo.yaml", ports: [{ port: 3000, protocol: "tcp" as const }], telo: "0.121.0" },
  { name: "worker", entryRelativePath: "worker.yaml", ports: [], telo: "0.121.0" },
];

function build(overrides: Partial<Parameters<typeof buildSessionPod>[0]> = {}) {
  return buildSessionPod({
    config,
    sessionId: "abc123",
    podName: "telo-session-abc123-x",
    apps: APPS,
    supervisorTokens: { web: "token-web", worker: "token-worker" },
    agent: {
      name: "authoring-agent",
      image: "ghcr.io/telorun/authoring-agent:1",
      env: { [OPERATOR_KEY]: "sk-operator-secret", AGENT_TOKEN: "agent-token" },
      pullPolicy: "missing",
      port: 8080,
      tokenEnv: "AGENT_TOKEN",
    },
    sessionConfig: {},
    claimName: "telo-session-abc123",
    workspaceAppConfigMap: "telo-workspace-app-deadbeef",
    hostEnv: { TELO_HOST_PUBLIC_URL_TEMPLATE: "https://{port}-abc123.telo.run" },
    limits: { app: clampLimits(config.limits, undefined), agent: clampLimits(config.appLimits, undefined) },
    ...overrides,
  });
}

const byName = (pod: ReturnType<typeof build>, name: string): V1Container =>
  pod.spec!.containers.find((c) => c.name === name)!;

const envOf = (c: V1Container): Record<string, string> =>
  Object.fromEntries((c.env ?? []).map((e) => [e.name, e.value ?? ""]));

describe("the session pod", () => {
  const pod = build();

  it("runs every app as an idle supervisor on its telo version's image, with no tty, no stdin and no session env", () => {
    expect(pod.spec!.containers.map((c) => c.name)).toEqual(["workspace", "app-web", "app-worker", "agent"]);
    APPS.forEach((app, index) => {
      const container = byName(pod, `app-${app.name}`);
      expect(container).toMatchObject({
        image: "telorun/node:0.121.0-slim",
        command: ["/opt/telo-runner/supervisor"],
      });
      expect(container.args).toBeUndefined();
      expect(container.tty).toBeUndefined();
      expect(container.stdin).toBeUndefined();
      expect(envOf(container)).toEqual({
        TELO_SUPERVISOR_LISTEN: `0.0.0.0:${9330 + index}`,
        TELO_SUPERVISOR_TOKEN: `token-${app.name}`,
        TELO_HOST_PUBLIC_URL_TEMPLATE: "https://{port}-abc123.telo.run",
        HOME: "/home/telo",
        npm_config_cache: "/home/telo/.npm",
      });
      expect(container.volumeMounts).toContainEqual({ name: "supervisor", mountPath: "/opt/telo-runner", readOnly: true });
    });
  });

  it("copies the supervisor out of the runner's image and prepares the volume's two directories first", () => {
    expect(pod.spec!.initContainers).toEqual([
      expect.objectContaining({
        name: "supervisor",
        image: "telorun/k8s-runner:0.22.0",
        command: [
          "sh",
          "-c",
          "mkdir -p /telo-session/workspace /telo-session/agent && cp /opt/telo-runner/supervisor /telo-runner-out/supervisor",
        ],
        volumeMounts: [
          { name: "supervisor", mountPath: "/telo-runner-out" },
          { name: "session", mountPath: "/telo-session" },
        ],
      }),
    ]);
  });

  it("mounts the session's own claim: workspace/ at /workspace everywhere, agent/ for the agent's state only", () => {
    expect(pod.spec!.volumes).toContainEqual({
      name: "session",
      persistentVolumeClaim: { claimName: "telo-session-abc123" },
    });
    for (const container of pod.spec!.containers) {
      expect(container.volumeMounts).toContainEqual({ name: "session", mountPath: "/workspace", subPath: "workspace" });
    }
    const agentState = { name: "session", mountPath: "/var/lib/telo-agent-state", subPath: "agent" };
    expect(byName(pod, "agent").volumeMounts).toContainEqual(agentState);
    expect(envOf(byName(pod, "agent")).TELO_HOST_STATE_DIR).toBe("/var/lib/telo-agent-state");
    for (const container of pod.spec!.containers.filter((c) => c.name !== "agent")) {
      expect(container.volumeMounts).not.toContainEqual(agentState);
    }
  });

  it("puts the operator env on the agent container and nowhere else", () => {
    for (const container of pod.spec!.containers) {
      if (container.name === "agent") expect(envOf(container)[OPERATOR_KEY]).toBe("sk-operator-secret");
      else expect(envOf(container)).not.toHaveProperty(OPERATOR_KEY);
    }
  });

  it("sizes app and workspace containers by RUNNER_MAX_* and the agent by RUNNER_APP_MAX_*", () => {
    for (const name of ["workspace", "app-web", "app-worker"]) {
      expect(byName(pod, name).resources).toEqual({
        limits: { cpu: "300m", memory: "512Mi", "ephemeral-storage": "1Gi" },
        requests: { cpu: "300m", memory: "512Mi" },
      });
    }
    expect(byName(pod, "agent").resources).toEqual({
      limits: { cpu: "500m", memory: "1Gi", "ephemeral-storage": "1Gi" },
      requests: { cpu: "500m", memory: "1Gi" },
    });
  });

  it("omits the agent container when none was asked for", () => {
    expect(build({ agent: undefined }).spec!.containers.map((c) => c.name)).toEqual([
      "workspace",
      "app-web",
      "app-worker",
    ]);
  });

  it("labels the pod for lookup and the sweep", () => {
    expect(pod.metadata!.labels).toEqual({
      "app.kubernetes.io/managed-by": "telo-k8s-runner",
      "telo.run/session-id": "abc123",
    });
  });
});

describe("reserved ports", () => {
  it("are each app's supervisor and debug-stream port, by position", () => {
    expect(reservedPortsFor(APPS)).toEqual([
      { app: "web", port: 9330, protocol: "tcp", purpose: "the session supervisor" },
      { app: "web", port: 9230, protocol: "tcp", purpose: "the kernel debug stream" },
      { app: "worker", port: 9331, protocol: "tcp", purpose: "the session supervisor" },
      { app: "worker", port: 9231, protocol: "tcp", purpose: "the kernel debug stream" },
    ]);
  });
});
