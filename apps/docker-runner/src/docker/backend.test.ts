import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORKSPACE_MARKER_CONTENTS,
  type AppState,
  type BackendStatus,
  type WorkloadCallbacks,
  type WorkloadSpec,
} from "@telorun/runner-core";
import { loadTeloImageSource } from "@telorun/runner-core/container";
import { afterEach, describe, expect, it } from "vitest";

// The fake gives each container a loopback address of its own (127.x.y.20 and up); macOS routes only 127.0.0.1.
const NO_LOOPBACK_ALIASES = process.platform === "darwin";

import { createDockerBackend } from "./backend.js";
import { agentContainer, appContainer, workspaceContainer } from "./container-spec.js";
import { FakeEngine } from "./fake-engine.test-support.js";

const NETWORK = "telo_default";
const VOLUME = "telo_runner-bundles";
const SUPERVISOR = { build: "0123456789abcdef", subpath: ".supervisor/0123456789abcdef" };
const APPS = [
  { name: "web", entryRelativePath: "telo.yaml", ports: [{ port: 3000, protocol: "tcp" as const }] },
  { name: "worker", entryRelativePath: "worker.yaml", ports: [] },
];
const AGENT = {
  name: "authoring-agent",
  source: { kind: "image" as const, image: "acme/agent:1" },
  env: { KEY: "operator" },
  pullPolicy: "missing" as const,
  port: 8080,
  tokenEnv: "AGENT_TOKEN",
};
const CONFIG = { image: "telorun/node:0-slim", pullPolicy: "missing" };

function spec(sessionId: string, overrides: Partial<WorkloadSpec> = {}): WorkloadSpec {
  return { sessionId, apps: APPS, config: CONFIG, tokens: {}, ...overrides };
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

let engine: FakeEngine;
let bundleRoot: string;
afterEach(async () => {
  await engine?.close();
  rmSync(bundleRoot, { recursive: true, force: true });
});

function boot() {
  engine = new FakeEngine();
  bundleRoot = mkdtempSync(join(tmpdir(), "docker-runner-bundles-"));
  return createDockerBackend({
    docker: engine.docker,
    bundleRoot,
    bundleVolume: VOLUME,
    childNetwork: NETWORK,
    teloImages: loadTeloImageSource({}),
    workspaceImage: "telorun/node:0-slim",
    supervisor: SUPERVISOR,
    log: { info() {}, warn() {} },
  });
}

/** The containers an earlier runner process created for a session. */
async function earlierContainers(sessionId: string, options: { agent?: boolean; live?: string } = {}) {
  const args = { sessionId, bundleVolume: VOLUME, childNetwork: NETWORK, publicBaseUrl: "http://run.test" };
  await engine.stand(workspaceContainer(args, "telorun/node:0-slim"));
  for (const [index, app] of APPS.entries()) {
    await engine.stand(
      appContainer(args, {
        app,
        index,
        image: "telorun/node:0-slim",
        token: `token-${app.name}`,
        supervisor: SUPERVISOR,
        ownsSessionAlias: index === 0,
      }),
      index === 0 ? options.live : undefined,
    );
  }
  if (options.agent !== false) {
    await engine.stand(
      agentContainer(args, { ...AGENT, env: { ...AGENT.env, AGENT_TOKEN: "agent-token" } }, CONFIG.image),
    );
  }
}

describe.skipIf(NO_LOOPBACK_ALIASES)("a session's containers", () => {
  it("run the supervisor in every app container, with no TTY, no stdin and no session env", async () => {
    const backend = boot();
    const workload = await backend.create(spec("s1", { agent: AGENT }), recorder().callbacks);
    await workload.runApp("web", {
      runId: "run-1",
      argv: ["telo", "run", "telo.yaml"],
      env: { SECRET: "session-value" },
      cwd: ".",
      io: "tty",
    });

    const web = engine.created.find((c) => c.name === "telo-run-s1-app-web")!;
    expect(web).toMatchObject({
      Image: "telorun/node:0-slim",
      Entrypoint: ["/opt/telo-runner/supervisor"],
      WorkingDir: "/workspace",
      Tty: false,
      OpenStdin: false,
      AttachStdin: false,
      Labels: { "telo.run/session-id": "s1", "telo.run/role": "app", "telo.run/app": "web" },
    });
    expect(web.Env).toEqual([
      "TELO_SUPERVISOR_LISTEN=0.0.0.0:9330",
      expect.stringMatching(/^TELO_SUPERVISOR_TOKEN=[\w-]{43}$/),
    ]);
    expect(web.HostConfig.Mounts).toEqual([
      { Type: "volume", Source: VOLUME, Target: "/workspace", VolumeOptions: { Subpath: "s1/workspace" } },
      {
        Type: "volume",
        Source: VOLUME,
        Target: "/opt/telo-runner",
        ReadOnly: true,
        VolumeOptions: { Subpath: SUPERVISOR.subpath },
      },
    ]);
    const worker = engine.created.find((c) => c.name === "telo-run-s1-app-worker")!;
    expect(worker.Env[0]).toBe("TELO_SUPERVISOR_LISTEN=0.0.0.0:9331");
    expect(worker.Env[1]).not.toBe(web.Env[1]);

    const agent = engine.created.find((c) => c.name === "telo-run-s1-agent")!;
    expect(agent.Env).toContain("TELO_HOST_STATE_DIR=/var/lib/telo-agent-state");
    expect(agent.HostConfig.Mounts).toContainEqual({
      Type: "volume",
      Source: VOLUME,
      Target: "/var/lib/telo-agent-state",
      VolumeOptions: { Subpath: "s1/agent" },
    });
    expect(JSON.stringify(engine.created)).not.toContain("session-value");
    expect(engine.supervisorOf("web").received.find((m) => m.type === "run")).toMatchObject({
      env: { SECRET: "session-value" },
    });
  });

  it("are removed on suspend and created again over the same directory, which goes only with the session", async () => {
    const backend = boot();
    const first = recorder();
    const workload = await backend.create(spec("s1"), first.callbacks);
    expect(engine.names()).toEqual(["telo-run-s1-app-web", "telo-run-s1-app-worker", "telo-run-s1-workspace"]);
    expect(first.statuses.map((s) => s.kind)).toEqual(["running"]);
    expect(first.states).toEqual([
      { app: "web", state: "ready" },
      { app: "worker", state: "ready" },
    ]);
    expect(engine.workspaceWrites).toEqual([
      { write: [{ path: "telo-workspace.yaml", content: WORKSPACE_MARKER_CONTENTS }] },
    ]);
    expect(existsSync(join(bundleRoot, "s1", "workspace"))).toBe(true);
    expect(existsSync(join(bundleRoot, "s1", "agent"))).toBe(true);

    await workload.suspend();
    expect(engine.names()).toEqual([]);
    expect(existsSync(join(bundleRoot, "s1", "agent"))).toBe(true);

    await backend.create(spec("s1"), recorder().callbacks);
    expect(engine.names()).toHaveLength(3);

    await backend.destroy("s1");
    expect(engine.names()).toEqual([]);
    expect(existsSync(join(bundleRoot, "s1"))).toBe(false);
  });

  it("replace only the app containers on an app-set change, keeping the workspace and the agent", async () => {
    const backend = boot();
    const workload = await backend.create(spec("s1", { agent: AGENT }), recorder().callbacks);
    const kept = ["telo-run-s1-workspace", "telo-run-s1-agent"].map((n) => engine.byName(n)!.id);

    await workload.setApps([APPS[0]!]);

    expect(engine.names()).toEqual(["telo-run-s1-agent", "telo-run-s1-app-web", "telo-run-s1-workspace"]);
    expect(["telo-run-s1-workspace", "telo-run-s1-agent"].map((n) => engine.byName(n)!.id)).toEqual(kept);
    expect(engine.removed).toEqual(["telo-run-s1-app-web", "telo-run-s1-app-worker"]);
  });

  it("rejects a port a reload declares when another app's machinery holds it, or when ports are published", async () => {
    const backend = boot();
    const r = recorder();
    const workload = await backend.create(spec("s1"), r.callbacks);
    workload.applyDeclaredPorts!("web", [...APPS[0]!.ports, { port: 9331, protocol: "tcp" }, { port: 4000, protocol: "tcp" }]);
    expect(r.endpoints.at(-1)).toEqual({
      app: "web",
      rejected: [
        { port: 9331, reason: "this runner reserves tcp port 9331 for the session supervisor of app 'worker'" },
        {
          port: 4000,
          reason:
            "this runner publishes session ports to the host, and a container's port bindings are fixed " +
            "at creation — change the app set or resume the session to reach this port",
        },
      ],
    });
  });
});

describe.skipIf(NO_LOOPBACK_ALIASES)("a container that ends", () => {
  it("fails the session naming the container, whether it exited or its supervisor restarted", async () => {
    const backend = boot();
    const ended = recorder();
    await backend.create(spec("s1"), ended.callbacks);
    await engine.end("telo-run-s1-app-worker", 137);
    await expect.poll(() => ended.statuses.at(-1)).toEqual({
      kind: "failed",
      message: "container 'telo-run-s1-app-worker' ended (exit code 137)",
    });

    await engine.close();
    const restarted = recorder();
    await backend.create(spec("s2"), restarted.callbacks);
    engine.supervisorOf("web").drop({ restart: true });
    await expect.poll(() => restarted.statuses.at(-1)).toMatchObject({
      kind: "failed",
      message: expect.stringMatching(
        /^the session supervisor of container 'telo-run-s2-app-web' can no longer be reached \(restarted\)/,
      ),
    });
  });
});

describe.skipIf(NO_LOOPBACK_ALIASES)("adoption at boot", () => {
  it("takes over running containers: the tokens read back from their inspect, each app's state from its supervisor", async () => {
    const backend = boot();
    await earlierContainers("s1", { live: "run-1" });
    const r = recorder();

    const adopted = await backend.adopt!(spec("s1", { agent: AGENT }), r.callbacks);

    expect(adopted?.tokens).toEqual({ agent: "agent-token" });
    expect(r.statuses.map((s) => s.kind)).toEqual(["running"]);
    expect(r.states).toEqual([
      { app: "web", state: "running", runId: "run-1" },
      { app: "worker", state: "ready" },
    ]);
    expect(engine.created).toHaveLength(4);

    await adopted!.workload.stopApp("web", "run-1", 10_000);
    await expect.poll(() => r.states.at(-1)).toMatchObject({ app: "web", state: "ready" });
  });

  it("removes containers whose supervisors speak another generation, or whose agent is not the stored one, keeping the directory", async () => {
    const backend = boot();
    mkdirSync(join(bundleRoot, "s1", "workspace"), { recursive: true });
    engine.generation = 2;
    await earlierContainers("s1");
    expect(await backend.adopt!(spec("s1", { agent: AGENT }), recorder().callbacks)).toBeUndefined();
    expect(engine.names()).toEqual([]);
    expect(existsSync(join(bundleRoot, "s1", "workspace"))).toBe(true);

    engine.generation = 1;
    await earlierContainers("s2", { agent: false });
    expect(await backend.adopt!(spec("s2", { agent: AGENT }), recorder().callbacks)).toBeUndefined();
    expect(engine.names()).toEqual([]);
  });

  it("refuses containers one of which ended, naming it", async () => {
    const backend = boot();
    await earlierContainers("s1");
    await engine.end("telo-run-s1-app-web", 1);
    await expect(backend.adopt!(spec("s1", { agent: AGENT }), recorder().callbacks)).rejects.toThrow(
      "container 'telo-run-s1-app-web' ended (exit code 1)",
    );
  });
});

describe("the orphan sweep", () => {
  it("removes every container of a session that is not live, every directory and supervisor build nothing uses", async () => {
    const backend = boot();
    engine.put("live-app", { "telo.run/session-id": "live", "telo.run/supervisor-build": "old-build" });
    engine.put("live-ctr", { "run.telo.session": "live" });
    engine.put("known-app", { "telo.run/session-id": "known" });
    engine.put("unknown-ctr", { "run.telo.session": "unknown" });
    engine.put("telo-run-legacy", {});
    engine.put("someone-else", {});
    for (const dir of ["live", "known", "unknown", ".supervisor/old-build", ".supervisor/stale", `${SUPERVISOR.subpath}`]) {
      mkdirSync(join(bundleRoot, dir), { recursive: true });
    }

    await backend.reapOrphans!({ known: new Set(["live", "known"]), live: new Set(["live"]) });

    expect(engine.names()).toEqual(["live-app", "live-ctr", "someone-else"]);
    expect(existsSync(join(bundleRoot, "unknown"))).toBe(false);
    expect(existsSync(join(bundleRoot, "known"))).toBe(true);
    expect(existsSync(join(bundleRoot, ".supervisor", "stale"))).toBe(false);
    expect(existsSync(join(bundleRoot, ".supervisor", "old-build"))).toBe(true);
    expect(existsSync(join(bundleRoot, SUPERVISOR.subpath))).toBe(true);
  });
});
