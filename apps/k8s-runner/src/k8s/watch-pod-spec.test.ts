import type { V1Container } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

import { loadK8sRunnerConfig } from "../config.js";
import { buildSessionPod, buildWatchPod } from "./pod-spec.js";

const BASE_ENV = {
  RUNNER_SELF_URL: "http://k8s-runner.telo-runner.svc:8062",
  RUNNER_WATCH_SESSIONS: "true",
};

const config = loadK8sRunnerConfig({ ...process.env, ...BASE_ENV });

const OPERATOR_KEY = "OPENAI_API_KEY";
const OPERATOR_VALUE = "sk-operator-secret";

function build(overrides: Partial<Parameters<typeof buildWatchPod>[0]> = {}) {
  return buildWatchPod({
    config,
    sessionId: "abc123",
    podName: "telo-watch-abc123",
    env: { APP_SETTING: "from-session" },
    apps: [
      { name: "web", entryRelativePath: "telo.yaml", ports: [{ port: 3000, protocol: "tcp" }], io: "tty" },
      { name: "worker", entryRelativePath: "worker.yaml", ports: [], io: "streams" },
    ],
    agent: {
      name: "authoring-agent",
      image: "ghcr.io/telorun/authoring-agent:1",
      env: { [OPERATOR_KEY]: OPERATOR_VALUE },
      pullPolicy: "missing",
      port: 8080,
    },
    limits: config.appLimits,
    image: "telorun/node:latest-slim",
    pullPolicy: "missing",
    workspaceAppConfigMap: "telo-workspace-app-deadbeef",
    ...overrides,
  });
}

const byName = (pod: ReturnType<typeof build>, name: string): V1Container =>
  pod.spec!.containers.find((c) => c.name === name)!;

const envOf = (c: V1Container): Record<string, string> =>
  Object.fromEntries((c.env ?? []).map((e) => [e.name, e.value ?? ""]));

describe("buildWatchPod — the credential boundary", () => {
  const pod = build();

  it("puts the operator env on the agent container and nowhere else", () => {
    // Structural before (two pods), a code invariant now (containers in one
    // pod) — so it needs a test that names the property directly.
    for (const container of pod.spec!.containers) {
      const env = envOf(container);
      if (container.name === "agent") {
        expect(env[OPERATOR_KEY]).toBe(OPERATOR_VALUE);
      } else {
        expect(env).not.toHaveProperty(OPERATOR_KEY);
      }
    }
  });

  it("gives every app container the session env and the workspace container neither", () => {
    expect(envOf(byName(pod, "app-web")).APP_SETTING).toBe("from-session");
    expect(envOf(byName(pod, "app-worker")).APP_SETTING).toBe("from-session");
    expect(envOf(byName(pod, "workspace"))).not.toHaveProperty("APP_SETTING");
    expect(envOf(byName(pod, "workspace"))).not.toHaveProperty(OPERATOR_KEY);
  });

  it("roots the agent at the session's shared workspace", () => {
    // The agent is one writer on the shared volume beside the app containers,
    // not the owner of a directory inside its own container. Its manifest reads
    // this to place every file tool and every spawned command.
    expect(envOf(byName(pod, "agent")).WORKSPACE_DIR).toBe("/workspace");
    expect(
      byName(pod, "agent").volumeMounts?.find((m) => m.name === "workspace")?.mountPath,
    ).toBe("/workspace");
  });

  it("runs at most one agent, whatever the app count", () => {
    expect(pod.spec!.containers.filter((c) => c.name === "agent")).toHaveLength(1);
  });

  // The pod's containers share one network namespace, so declaring the port is
  // all the agent needs to be reachable through the session's own Service —
  // there is no routing of its own to arrange.
  it("declares the agent's port so the session's Service can carry it", () => {
    expect(byName(pod, "agent").ports).toEqual([{ containerPort: 8080, protocol: "TCP" }]);
  });

  it("declares no port for an agent whose catalog entry has none", () => {
    const portless = build({
      agent: {
        name: "authoring-agent",
        image: "ghcr.io/telorun/authoring-agent:1",
        env: {},
        pullPolicy: "missing",
      },
    });
    expect(byName(portless, "agent").ports).toBeUndefined();
  });

  it("omits the agent container entirely when none was requested", () => {
    const bare = build({ agent: undefined });
    expect(bare.spec!.containers.map((c) => c.name)).toEqual([
      "workspace",
      "app-web",
      "app-worker",
    ]);
  });
});

describe("buildWatchPod — the shared workspace", () => {
  const pod = build();

  it("shares one GID across every container", () => {
    // Without this the agent writes files the app cannot read, which surfaces
    // as a manifest that "does not exist" one reload after it was written.
    expect(pod.spec!.securityContext?.fsGroup).toBe(1000);
    for (const container of pod.spec!.containers) {
      const mount = container.volumeMounts?.find((m) => m.name === "workspace");
      expect(mount?.mountPath).toBe("/workspace");
      expect(mount?.readOnly).toBeFalsy();
    }
  });

  it("leaves every app's cache to the workspace marker", () => {
    // `TELO_CACHE_DIR` OUTRANKS the marker, so setting it per app is exactly
    // what would give each app its own cache. Without it the kernel walks up
    // from the entry manifest to `telo-workspace.yaml` at the workspace root and
    // anchors one `.telo` there for the whole session.
    expect(envOf(byName(pod, "app-web"))).not.toHaveProperty("TELO_CACHE_DIR");
    expect(envOf(byName(pod, "app-worker"))).not.toHaveProperty("TELO_CACHE_DIR");
    for (const name of ["app-web", "app-worker"]) {
      expect(byName(pod, name).volumeMounts?.map((m) => m.name)).not.toContain("telo-cache");
    }
  });

  it("gives the workspace container an explicit cache root", () => {
    // Its manifest lives OUTSIDE the workspace, so the walk-up from its entry
    // would never reach the marker.
    expect(envOf(byName(pod, "workspace")).TELO_CACHE_DIR).toBe("/telo-cache/workspace");
  });

  it("mounts the workspace application's manifest read-only, outside /workspace", () => {
    const mount = byName(pod, "workspace").volumeMounts?.find((m) => m.name === "workspace-app");
    expect(mount?.readOnly).toBe(true);
    expect(mount?.mountPath).not.toContain("/workspace/");
    expect(pod.spec!.volumes?.find((v) => v.name === "workspace-app")?.configMap?.name).toBe(
      "telo-workspace-app-deadbeef",
    );
  });
});

describe("buildWatchPod — how each app runs", () => {
  const pod = build();

  it("keeps every app container's hardening identical to a run session's", () => {
    const runPod = buildSessionPod({
      config,
      sessionId: "abc123",
      podName: "telo-run-abc123",
      entryRelativePath: "telo.yaml",
      env: {},
      ports: [],
      limits: config.limits,
      image: "prebuilt",
      bundleUrl: "http://runner/bundle",
      inspect: false,
    });
    const expected = runPod.spec!.containers[0].securityContext;
    expect(byName(pod, "app-web").securityContext).toEqual(expected);
    expect(byName(pod, "app-worker").securityContext).toEqual(expected);
  });

  it("waits for its entry manifest, then runs under --watch with a distinct inspect port", () => {
    const web = envOf(byName(pod, "app-web"));
    const worker = envOf(byName(pod, "app-worker"));
    expect(web.TELO_ENTRY).toBe("/workspace/telo.yaml");
    expect(worker.TELO_ENTRY).toBe("/workspace/worker.yaml");
    // Containers in one pod share a network namespace, so a second bind on the
    // same port would fail.
    expect(web.TELO_INSPECT_ADDR).not.toBe(worker.TELO_INSPECT_ADDR);

    const command = byName(pod, "app-web").command!.join(" ");
    expect(command).toContain("while [ ! -f \"$TELO_ENTRY\" ]");
    expect(command).toContain("--watch");
    expect(command).toContain("--inspect");
    // The path never reaches the shell line — a value that did could close a quote.
    expect(command).not.toContain("/workspace/telo.yaml");
  });

  it("forces colour only under a terminal", () => {
    expect(envOf(byName(pod, "app-web")).CLICOLOR_FORCE).toBe("1");
    // `streams` exists to show what production sees; forcing colour there would
    // defeat the mode by putting ANSI into what is meant to be a pipe.
    expect(envOf(byName(pod, "app-worker"))).not.toHaveProperty("CLICOLOR_FORCE");
    expect(byName(pod, "app-web").tty).toBe(true);
    expect(byName(pod, "app-worker").tty).toBe(false);
  });

  it("takes the watch TTL, not the run-session one", () => {
    expect(pod.spec!.activeDeadlineSeconds).toBe(config.watch.maxTtlSeconds);
  });

  it("labels the pod for orphan reaping and marks it as a watch session", () => {
    expect(pod.metadata?.labels).toMatchObject({
      "app.kubernetes.io/managed-by": "telo-k8s-runner",
      "telo.run/session-id": "abc123",
      "telo.run/mode": "watch",
    });
  });
});
