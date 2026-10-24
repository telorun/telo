import { describe, expect, it, vi } from "vitest";

import type { RunnerCredentials } from "../runner-credentials";
import { WorkspaceSession, type WorkspaceIdentity } from "../workspace-session";
import type { WorkspaceSessionEntry } from "../workspace-session-entry";
import { RunnerRefusal } from "../types";
import { FakeRunner, app, emptyBridge, memoryResumeSecretStore, settle } from "./fake-runner";

const SCOPE = { runner: "r1", workspaceKey: "/ws" };

function open(
  runner: FakeRunner,
  mode: "agent" | "manual",
  entry: WorkspaceSessionEntry = { mode, workspace: "device:1" },
  identity: WorkspaceIdentity | null = null,
) {
  const secrets = memoryResumeSecretStore();
  const saved: WorkspaceSessionEntry[] = [];
  const reruns: string[] = [];
  const session = new WorkspaceSession({
    workspaceKey: "/ws",
    entry,
    runner: { id: "r1", adapter: runner.adapter, config: {} },
    mode,
    termsAccepted: () => true,
    secrets,
    identity,
    saveEntry: (next) => saved.push(next),
    bridge: emptyBridge,
    listener: { changed() {}, event() {}, rerun: (name) => reruns.push(name), syncFailed() {} },
  });
  return { session, secrets, saved, reruns };
}

describe("a workspace's session", () => {
  it("is created once its app set settles, with the agent in Agent mode, and its id and secret are kept", async () => {
    const runner = new FakeRunner();
    const { session, secrets, saved } = open(runner, "agent");
    void session.open();
    await settle();
    expect(runner.creates).toEqual([]);

    session.setDesired([app("api", [3000])], true, false);
    await settle();

    expect(runner.creates).toEqual([{ workspace: "device:1", apps: [app("api", [3000])], agent: "authoring-agent" }]);
    expect(saved.at(-1)).toEqual({ mode: "agent", workspace: "device:1", runner: "r1", sessionId: "s1" });
    expect(await secrets.read(SCOPE)).toBe("secret-s1");
    expect(session.state.phase).toBe("live");
  });

  it("holds an app-set change while an agent turn runs, and applies it when the turn ends", async () => {
    const runner = new FakeRunner();
    const { session } = open(runner, "agent");
    session.setDesired([app("api")], true, false);
    await session.open();
    const fake = runner.sessions.get("s1")!;
    fake.up();
    await settle();

    session.setTurnActive(true);
    session.setDesired([app("api"), app("worker")], true, false);
    await settle();
    expect(fake.setAppsCalls).toEqual([]);
    expect(session.state.appSet.pending).toBe("turn");

    session.setTurnActive(false);
    await settle();
    expect(fake.setAppsCalls).toEqual([[app("api"), app("worker")]]);
  });

  it("applies an app-set change at once in Manual mode, where no agent runs a turn", async () => {
    const runner = new FakeRunner();
    const { session } = open(runner, "manual");
    session.setDesired([app("api")], true, false);
    await session.open();
    const fake = runner.sessions.get("s1")!;
    expect(runner.creates[0]?.agent).toBeUndefined();
    fake.up();
    await settle();

    session.setTurnActive(true);
    session.setDesired([app("api"), app("worker")], true, false);
    await settle();
    expect(fake.setAppsCalls).toEqual([[app("api"), app("worker")]]);
  });

  it("runs an app the session does not hold yet once the set is applied and its container is ready", async () => {
    const runner = new FakeRunner();
    const { session } = open(runner, "agent");
    session.setDesired([app("api")], true, false);
    await session.open();
    const fake = runner.sessions.get("s1")!;
    fake.up();
    await settle();
    session.setTurnActive(true);
    session.setDesired([app("api"), app("worker")], true, false);

    const started = vi.fn();
    void session.run("worker", { env: { A: "1" }, io: "tty" }).then(started);
    await settle();
    expect(session.state.waiting.get("worker")).toBe("turn");
    expect(fake.runCalls).toEqual([]);

    session.setTurnActive(false);
    await settle();
    expect(fake.runCalls).toEqual([]);
    fake.emit({ type: "app", app: "worker", state: "ready" });
    await settle();
    expect(fake.runCalls).toEqual([{ app: "worker", request: { env: { A: "1" }, io: "tty" } }]);
    expect(started).toHaveBeenCalledWith("run-1");
  });

  it("asks for a run again for each app that was running when the pod was recreated", async () => {
    const runner = new FakeRunner();
    const { session, reruns } = open(runner, "manual");
    session.setDesired([app("api"), app("job")], true, false);
    await session.open();
    const fake = runner.sessions.get("s1")!;
    fake.up();
    await settle();
    await session.run("api", { env: {}, io: "tty" });

    session.setDesired([app("api"), app("job"), app("worker")], true, false);
    await settle();
    expect(reruns).toEqual([]);
    // The new pod comes up: each app reports ready with no run ending.
    for (const name of ["api", "job", "worker"]) fake.emit({ type: "app", app: name, state: "ready" });
    await settle();
    expect(reruns).toEqual(["api"]);
  });

  it("is created again when the stored one is gone, and resumed when it was suspended", async () => {
    const runner = new FakeRunner();
    const first = open(runner, "manual");
    first.session.setDesired([app("api")], true, false);
    await first.session.open();
    const stored = first.saved.at(-1)!;
    runner.sessions.get("s1")!.status = { kind: "suspended" };

    const again = open(runner, "manual", stored);
    await again.secrets.write(SCOPE, await first.secrets.read(SCOPE));
    again.session.setDesired([app("api")], true, false);
    await again.session.open();
    expect(runner.creates).toHaveLength(1);
    expect(runner.sessions.get("s1")!.status.kind).toBe("starting");

    runner.drop("s1");
    const third = open(runner, "manual", stored);
    await third.secrets.write(SCOPE, await first.secrets.read(SCOPE));
    third.session.setDesired([app("api")], true, false);
    await third.session.open();
    expect(runner.creates).toHaveLength(2);
    expect(third.saved.at(-1)?.sessionId).toBe("s2");
  });

  it("is reached with the identity on a runner that accepts it at the address it is reached on, and says why not otherwise", async () => {
    const identityCredentials: RunnerCredentials = { headers: async () => ({ authorization: "DPoP at", dpop: "proof" }) };
    const identity: WorkspaceIdentity = { issuer: "https://issuer.test", credentials: () => identityCredentials };
    const runner = new FakeRunner();
    runner.connection.baseUrl = "https://runner.test";
    runner.capabilities = {
      ...runner.capabilities,
      identity: { resource: "https://runner.test", authorization_servers: ["https://issuer.test"] },
    };
    const accepted = open(runner, "manual", undefined, identity);
    accepted.session.setDesired([app("api")], true, false);
    await accepted.session.open();
    expect(accepted.session.state.credential).toEqual({ kind: "identity" });
    expect(runner.owners.get("s1")).toBe("identity");
    expect(accepted.saved.at(-1)).toEqual({ mode: "manual", workspace: "device:1", runner: "r1", sessionId: "s1", owner: "identity" });
    expect(await accepted.secrets.read(SCOPE)).toBeNull();

    runner.capabilities = {
      ...runner.capabilities,
      identity: { resource: "https://other-runner.test", authorization_servers: ["https://issuer.test"] },
    };
    const mismatched = open(runner, "manual", { mode: "manual", workspace: "device:2" }, identity);
    mismatched.session.setDesired([app("api")], true, false);
    await mismatched.session.open();
    expect(mismatched.session.state.credential).toEqual({
      kind: "secret",
      reason: expect.stringContaining("advertised address (https://other-runner.test) does not match"),
    });
    expect(runner.owners.get("s2")).toBe("Bearer secret-s2");
  });

  it("reads the runner's capabilities once connected, since a local runner says nothing before it is up", async () => {
    const runner = new FakeRunner();
    let up = false;
    runner.adapter.fetchCapabilities = async () => (up ? runner.capabilities : null);
    runner.adapter.connect = async () => {
      up = true;
      return runner.connection;
    };
    const { session } = open(runner, "agent");
    session.setDesired([app("api")], true, false);
    await session.open();

    expect(session.state.capabilities).toEqual(runner.capabilities);
    expect(session.state.agentOffered).toBe(true);
    expect(runner.creates[0]?.agent).toBe("authoring-agent");
  });

  it("is created only with a set that names telo versions exactly when the runner takes them", async () => {
    const runner = new FakeRunner();
    runner.capabilities = { ...runner.capabilities, features: { ...runner.capabilities.features, teloVersions: true } };
    const { session } = open(runner, "manual");
    session.setDesired([app("api")], true, false);
    void session.open();
    await settle();
    expect(runner.creates).toEqual([]);

    const versioned = { ...app("api"), telo: "0.123.0" };
    session.setDesired([versioned], true, true);
    await settle();
    expect(runner.creates.map((c) => c.apps)).toEqual([[versioned]]);
  });

  it("sends a change the runner answered session_busy again only after a delay", async () => {
    vi.useFakeTimers();
    try {
      const runner = new FakeRunner();
      const { session } = open(runner, "manual");
      session.setDesired([app("api")], true, false);
      await session.open();
      const fake = runner.sessions.get("s1")!;
      fake.up();
      await vi.advanceTimersByTimeAsync(0);
      const setApps = fake.setApps.bind(fake);
      let busy = true;
      fake.setApps = async (apps) => {
        fake.setAppsCalls.push(apps);
        if (busy) throw new RunnerRefusal(409, "session_busy", "the session is busy");
        await setApps(apps);
      };

      session.setDesired([app("api"), app("worker")], true, false);
      await vi.advanceTimersByTimeAsync(100);
      expect(fake.setAppsCalls).toHaveLength(1);

      busy = false;
      await vi.advanceTimersByTimeAsync(250);
      expect(fake.setAppsCalls).toHaveLength(3);
      expect(session.state.applied).toEqual(new Set(["api", "worker"]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("says why a running session in Agent mode has no agent when the runner reports no address for it", async () => {
    const runner = new FakeRunner();
    const { session } = open(runner, "agent");
    session.setDesired([app("api")], true, false);
    await session.open();
    runner.sessions.get("s1")!.up();
    await settle();

    expect(session.state.agentUnavailable).toContain("reports no address");
  });

  it("says why a running session in Agent mode has no agent when its change was refused", async () => {
    const runner = new FakeRunner();
    const { session } = open(runner, "manual");
    session.setDesired([app("api")], true, false);
    await session.open();
    const fake = runner.sessions.get("s1")!;
    fake.setAgent = async () => {
      throw new RunnerRefusal(400, "agent_port_conflict", "an app declares the agent's port");
    };
    fake.up();
    await settle();

    session.setMode("agent");
    await settle();
    expect(session.state.agentUnavailable).toBe(
      "The session's agent could not be changed: an app declares the agent's port",
    );
  });
});
