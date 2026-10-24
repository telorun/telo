import type { V1Pod } from "@kubernetes/client-node";
import {
  WORKSPACE_MARKER_CONTENTS,
  type AppState,
  type BackendStatus,
  type WorkloadCallbacks,
  type WorkloadSpec,
} from "@telorun/runner-core";
import { afterEach, describe, expect, it } from "vitest";

// The fake gives each container a loopback address of its own (127.x.y.20 and up); macOS routes only 127.0.0.1.
const NO_LOOPBACK_ALIASES = process.platform === "darwin";

import { loadK8sRunnerConfig } from "../config.js";
import { clampLimits } from "../limits.js";
import { createKubernetesBackend } from "./backend.js";
import { FakeCluster } from "./fake-cluster.test-support.js";
import { buildSessionPod } from "./pod-spec.js";

const config = loadK8sRunnerConfig({
  RUNNER_SUPERVISOR_IMAGE: "telorun/k8s-runner:test",
  RUNNER_STATE_DIR: "/var/lib/telo-runner",
});
const log = { info() {}, warn() {} };

const APPS = [
  { name: "web", entryRelativePath: "telo.yaml", ports: [{ port: 3000, protocol: "tcp" as const }] },
  { name: "worker", entryRelativePath: "worker.yaml", ports: [] },
];
const AGENT = {
  name: "agent",
  image: "acme/agent:1",
  env: { KEY: "operator" },
  pullPolicy: "missing" as const,
  port: 8080,
  tokenEnv: "AGENT_TOKEN",
};

function spec(sessionId: string, overrides: Partial<WorkloadSpec> = {}): WorkloadSpec {
  return { sessionId, apps: APPS, config: {}, tokens: {}, ...overrides };
}

function recorder() {
  const statuses: BackendStatus[] = [];
  const states: Array<{ app: string } & AppState> = [];
  const endpoints: Array<{ app: string; rejected?: Array<{ port: number; reason: string }> }> = [];
  const callbacks: WorkloadCallbacks = {
    onStatus: (status) => statuses.push(status),
    onProgress: () => {},
    onAppState: (app, state) => states.push({ app, ...state }),
    onOutput: () => {},
    onRoute: () => {},
    onEndpoints: (app, change) => endpoints.push({ app, ...change }),
  };
  return { statuses, states, endpoints, callbacks };
}

/** A pod an earlier runner process created, as it reads back from the API. */
function earlierPod(sessionId: string, agent = true): V1Pod {
  return buildSessionPod({
    config,
    sessionId,
    podName: `telo-session-${sessionId}-old`,
    apps: APPS,
    supervisorTokens: { web: "token-web", worker: "token-worker" },
    agent: agent ? { ...AGENT, env: { ...AGENT.env, AGENT_TOKEN: "agent-token" } } : undefined,
    sessionConfig: {},
    claimName: `telo-session-${sessionId}`,
    workspaceAppConfigMap: "telo-workspace-app-x",
    hostEnv: {},
    limits: { app: clampLimits(config.limits, undefined), agent: clampLimits(config.appLimits, undefined) },
  });
}

let cluster: FakeCluster;
afterEach(async () => {
  await cluster?.close();
});

function boot() {
  cluster = new FakeCluster();
  return createKubernetesBackend({ kube: cluster.kube, config, log });
}

describe.skipIf(NO_LOOPBACK_ALIASES)("a session's storage", () => {
  it("is a claim the pod mounts, kept when the pod goes and mounted again by the next one, deleted with the session", async () => {
    const backend = boot();
    const first = recorder();
    const workload = await backend.create(spec("s1"), first.callbacks);

    expect([...cluster.claims.keys()]).toEqual(["telo-session-s1"]);
    expect(cluster.claims.get("telo-session-s1")!.metadata.labels).toEqual({
      "app.kubernetes.io/managed-by": "telo-k8s-runner",
      "telo.run/session-id": "s1",
    });
    expect(cluster.onlyPod().spec!.volumes).toContainEqual({
      name: "session",
      persistentVolumeClaim: { claimName: "telo-session-s1" },
    });
    expect(first.statuses.map((s) => s.kind)).toEqual(["running"]);
    expect(first.states).toEqual([
      { app: "web", state: "ready" },
      { app: "worker", state: "ready" },
    ]);
    expect(cluster.workspaceWrites).toEqual([
      { write: [{ path: "telo-workspace.yaml", content: WORKSPACE_MARKER_CONTENTS }] },
    ]);

    await workload.suspend();
    expect(cluster.pods.size).toBe(0);
    expect([...cluster.claims.keys()]).toEqual(["telo-session-s1"]);

    await backend.create(spec("s1"), recorder().callbacks);
    expect(cluster.onlyPod().spec!.volumes).toContainEqual({
      name: "session",
      persistentVolumeClaim: { claimName: "telo-session-s1" },
    });

    await backend.destroy("s1");
    expect(cluster.pods.size).toBe(0);
    expect(cluster.claims.size).toBe(0);
  });

  it("replaces the pod over the same claim when the app set changes, and keeps it when only an entry moved", async () => {
    const backend = boot();
    const r = recorder();
    const workload = await backend.create(spec("s1"), r.callbacks);
    const before = cluster.onlyPod().metadata!.name;

    await workload.setApps([{ ...APPS[0]!, entryRelativePath: "moved.yaml" }, APPS[1]!]);
    expect(cluster.onlyPod().metadata!.name).toBe(before);

    await workload.setApps([APPS[0]!]);
    const after = cluster.onlyPod();
    expect(after.metadata!.name).not.toBe(before);
    expect(after.spec!.containers.map((c) => c.name)).toEqual(["workspace", "app-web"]);
    expect(cluster.claims.size).toBe(1);
  });
});

describe.skipIf(NO_LOOPBACK_ALIASES)("running an app", () => {
  it("starts and stops a run through the app's supervisor; the run's env reaches it and never the pod", async () => {
    const backend = boot();
    const r = recorder();
    const workload = await backend.create(spec("s1"), r.callbacks);
    const run = {
      runId: "run-1",
      argv: ["telo", "run", "telo.yaml"],
      env: { SECRET: "session-value" },
      cwd: ".",
      io: "tty" as const,
    };

    await workload.runApp("web", run);
    expect(cluster.supervisorOf("web").received.find((m) => m.type === "run")).toEqual({ type: "run", ...run });
    expect(r.states.at(-1)).toEqual({ app: "web", state: "running", runId: "run-1" });
    expect(JSON.stringify(cluster.onlyPod().spec)).not.toContain("session-value");

    await workload.stopApp("web", "run-1", 10_000);
    await expect.poll(() => r.states.at(-1)).toEqual({
      app: "web",
      state: "ready",
      ended: { runId: "run-1", signal: "SIGTERM" },
    });
  });

  it("rejects a port a reload declares when the pod reserves it", async () => {
    const backend = boot();
    const r = recorder();
    const workload = await backend.create(spec("s1"), r.callbacks);
    workload.applyDeclaredPorts!("web", [...APPS[0]!.ports, { port: 9331, protocol: "tcp" }]);
    await expect.poll(() => r.endpoints.at(-1)).toEqual({
      app: "web",
      rejected: [
        { port: 9331, reason: "this runner reserves tcp port 9331 for the session supervisor of app 'worker'" },
      ],
    });
  });
});

describe.skipIf(NO_LOOPBACK_ALIASES)("a container that ends", () => {
  it("fails the session naming the container, whether its status says so or its supervisor restarted", async () => {
    const backend = boot();
    const ended = recorder();
    await backend.create(spec("s1"), ended.callbacks);
    const pod = cluster.onlyPod();
    cluster.emit("MODIFIED", {
      ...pod,
      status: {
        ...pod.status,
        containerStatuses: pod.status!.containerStatuses!.map((c) =>
          c.name === "app-worker" ? { ...c, state: { terminated: { exitCode: 137, reason: "OOMKilled" } } } : c,
        ),
      },
    });
    expect(ended.statuses.at(-1)).toEqual({
      kind: "failed",
      message: "container 'app-worker' ended (OOMKilled, exit code 137)",
    });

    await cluster.close();
    const restarted = recorder();
    await backend.create(spec("s2"), restarted.callbacks);
    cluster.supervisorOf("web").drop({ restart: true });
    await expect.poll(() => restarted.statuses.at(-1)).toMatchObject({
      kind: "failed",
      message: expect.stringMatching(/^the session supervisor of container 'app-web' can no longer be reached \(restarted\)/),
    });
  });
});

describe.skipIf(NO_LOOPBACK_ALIASES)("adoption at boot", () => {
  it("takes over a running pod: the tokens read back from its spec, each app's state from its supervisor", async () => {
    const backend = boot();
    await cluster.start(earlierPod("s1"), { web: "run-1" });
    const r = recorder();

    const adopted = await backend.adopt!(spec("s1", { agent: AGENT }), r.callbacks);

    expect(adopted?.tokens).toEqual({ agent: "agent-token" });
    expect(r.statuses.map((s) => s.kind)).toEqual(["running"]);
    expect(r.states).toEqual([
      { app: "web", state: "running", runId: "run-1" },
      { app: "worker", state: "ready" },
    ]);
    expect(cluster.supervisorOf("web").received[0]).toEqual({ type: "hello", generation: 1, lastSeq: 0 });

    await adopted!.workload.stopApp("web", "run-1", 10_000);
    await expect.poll(() => r.states.at(-1)).toMatchObject({ app: "web", state: "ready" });
  });

  it("removes a pod whose supervisors speak another generation, or whose agent is not the stored one, and suspends", async () => {
    const backend = boot();
    cluster.generation = 2;
    await cluster.start(earlierPod("s1"));
    expect(await backend.adopt!(spec("s1", { agent: AGENT }), recorder().callbacks)).toBeUndefined();
    expect(cluster.pods.size).toBe(0);

    cluster.generation = 1;
    await cluster.start(earlierPod("s2", false));
    expect(await backend.adopt!(spec("s2", { agent: AGENT }), recorder().callbacks)).toBeUndefined();
    expect(cluster.pods.size).toBe(0);
    expect(cluster.deletedClaims).toEqual([]);
  });

  it("refuses a pod one of whose containers ended, naming it", async () => {
    const backend = boot();
    const pod = await cluster.start(earlierPod("s1"));
    pod.status!.containerStatuses = pod.status!.containerStatuses!.map((c) =>
      c.name === "app-web" ? { ...c, state: { terminated: { exitCode: 1, reason: "Error" } } } : c,
    );
    await expect(backend.adopt!(spec("s1", { agent: AGENT }), recorder().callbacks)).rejects.toThrow(
      "container 'app-web' ended (Error, exit code 1)",
    );
  });
});

describe("the orphan sweep", () => {
  it("removes every pod of a session that is not live and every claim of a session the store does not know", async () => {
    const backend = boot();
    const managed = "telo-k8s-runner";
    const put = (name: string, labels: Record<string, string>) =>
      cluster.pods.set(name, {
        pod: { metadata: { name, labels: { "app.kubernetes.io/managed-by": managed, ...labels } } },
        supervisors: new Map(),
        servers: [],
      });
    put("live-pod", { "telo.run/session-id": "live" });
    put("live-ctr", { "run.telo.session": "live" });
    put("known-pod", { "telo.run/session-id": "known" });
    put("unknown-pod", { "telo.run/session-id": "unknown" });
    put("unknown-ctr", { "run.telo.session": "unknown" });
    for (const id of ["live", "known", "unknown"]) {
      cluster.claims.set(`telo-session-${id}`, {
        metadata: {
          name: `telo-session-${id}`,
          labels: { "app.kubernetes.io/managed-by": managed, "telo.run/session-id": id },
        },
      });
    }

    await backend.reapOrphans!({ known: new Set(["live", "known"]), live: new Set(["live"]) });

    expect([...cluster.pods.keys()]).toEqual(["live-pod", "live-ctr"]);
    expect([...cluster.claims.keys()]).toEqual(["telo-session-live", "telo-session-known"]);
  });
});
