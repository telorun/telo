import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../server.js";
import { makeFakeDocker, makeRunnerConfig, waitFor } from "../test-helpers.js";

/**
 * Request-level validation of watch sessions. Everything asserted here is
 * rejected BEFORE a workload starts, which is the point: a session that reaches
 * a container and only then discovers it cannot route two apps to one host is a
 * worse outcome than a 400.
 */
interface Harness {
  app: FastifyInstance;
  bundleRoot: string;
  docker: ReturnType<typeof makeFakeDocker>;
}

const BODY = {
  bundle: {
    entryRelativePath: "telo.yaml",
    files: [{ relativePath: "telo.yaml", contents: "kind: Telo.Application\n" }],
  },
  env: {},
  config: { image: "telorun/node:latest-slim", pullPolicy: "missing" as const },
};

const CATALOG = JSON.stringify({
  "authoring-agent": {
    image: "ghcr.io/telorun/authoring-agent:1",
    env: { KEY: "secret" },
    port: 8080,
  },
});

/** The same entry with no port — an agent the runner has no way to route. */
const PORTLESS_CATALOG = JSON.stringify({
  "authoring-agent": { image: "ghcr.io/telorun/authoring-agent:1", env: { KEY: "secret" } },
});

async function harness(watchEnabled: boolean, apps?: string): Promise<Harness> {
  const bundleRoot = await mkdtemp(join(tmpdir(), "docker-runner-watch-"));
  const previous = process.env.RUNNER_APPS;
  if (apps) process.env.RUNNER_APPS = apps;
  else delete process.env.RUNNER_APPS;
  try {
    const runnerConfig = makeRunnerConfig({
      bundleRoot,
      watch: {
        enabled: watchEnabled,
        idleMs: 300_000,
        maxTtlSeconds: 21_600,
        maxSessions: 8,
        reloadLimitPerMinute: 30,
        suspendedTtlMs: 86_400_000,
        checkpointMs: 30_000,
      },
    });
    const docker = makeFakeDocker({});
    const { app } = await buildServer({ docker, runnerConfig });
    await app.ready();
    return { app, bundleRoot, docker };
  } finally {
    if (previous === undefined) delete process.env.RUNNER_APPS;
    else process.env.RUNNER_APPS = previous;
  }
}

describe("watch session validation", () => {
  let h: Harness;
  afterEach(async () => {
    if (h) {
      await h.app.close();
      await rm(h.bundleRoot, { recursive: true, force: true });
    }
  });

  it("refuses a watch session when the operator has not enabled one", async () => {
    h = await harness(false);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { ...BODY, mode: "watch" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("watch_disabled");
  });

  it("advertises watch and the agent catalog on /v1/capabilities", async () => {
    h = await harness(true, CATALOG);
    const caps = (await h.app.inject({ method: "GET", url: "/v1/capabilities" })).json();
    expect(caps.features.watch).toBe(true);
    expect(caps.features.io).toEqual(["tty", "streams"]);
    expect(caps.features.agents).toEqual(["authoring-agent"]);
  });

  it("rejects an agent with nothing watching its writes", async () => {
    h = await harness(true, CATALOG);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { ...BODY, agent: "authoring-agent" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("agent_requires_watch");
  });

  it("rejects an agent the catalog does not offer", async () => {
    h = await harness(true, CATALOG);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { ...BODY, mode: "watch", agent: "not-a-thing" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unknown_agent");
  });

  it("rejects an agent the operator gave no port", async () => {
    // An agent nothing can reach is the same silent no-op as an agent nothing
    // watches. The port is the operator's to declare, so the message names
    // their config rather than anything the caller can change.
    h = await harness(true, PORTLESS_CATALOG);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { ...BODY, mode: "watch", agent: "authoring-agent" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("agent_port_undeclared");
    expect(res.json().message).toContain("RUNNER_APPS.authoring-agent.port");
  });

  it("starts without the agent when an app declares the agent's port", async () => {
    // The manifest wins. A client asks for an agent as a convenience — the
    // editor does so on every run, without the user choosing — so refusing the
    // session would make an app that declares 8080 unrunnable for a reason
    // naming a container the user never requested and cannot decline.
    h = await harness(true, CATALOG);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        ...BODY,
        mode: "watch",
        agent: "authoring-agent",
        ports: [{ port: 8080, protocol: "tcp" }],
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("advertises only catalog entries that declare a port", async () => {
    // The advertised set and the accepted set have to be one list. An operator
    // upgrading keeps a catalog with no `port` anywhere — the field is new — so
    // advertising it unfiltered makes the editor attach an agent to every run
    // and every run is refused.
    h = await harness(true, PORTLESS_CATALOG);
    const caps = (await h.app.inject({ method: "GET", url: "/v1/capabilities" })).json();
    expect(caps.features.agents).toBeUndefined();
  });

  it("rejects two apps declaring the same port", async () => {
    // Session hosts carry no app name, so the two would be indistinguishable.
    // A rejected request beats a URL that silently reaches the wrong app.
    h = await harness(true);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        ...BODY,
        mode: "watch",
        apps: [
          { name: "web", entryRelativePath: "telo.yaml", ports: [{ port: 3000, protocol: "tcp" }] },
          { name: "admin", entryRelativePath: "admin.yaml", ports: [{ port: 3000, protocol: "tcp" }] },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("port_conflict");
    expect(res.json().message).toContain("web");
    expect(res.json().message).toContain("admin");
  });

  it("rejects an app name that is not a DNS label", async () => {
    h = await harness(true);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        ...BODY,
        mode: "watch",
        apps: [{ name: "Web_App", entryRelativePath: "telo.yaml" }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_app_name");
  });

  it("rejects an app name a session's own containers use", async () => {
    // The docker backend keys every container of a session in one map, so an app
    // called `workspace` would overwrite the workspace handle and leak the real
    // container. Reserved in core so one rule covers both backends.
    h = await harness(true);
    for (const name of ["workspace", "agent"]) {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/sessions",
        payload: { ...BODY, mode: "watch", apps: [{ name, entryRelativePath: "telo.yaml" }] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("reserved_app_name");
    }
  });

  it("rejects a duplicate app name", async () => {
    h = await harness(true);
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        ...BODY,
        mode: "watch",
        apps: [
          { name: "web", entryRelativePath: "telo.yaml" },
          { name: "web", entryRelativePath: "other.yaml" },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("duplicate_app_name");
  });

  it("drops a client-supplied TELO_CACHE_DIR", async () => {
    // It OUTRANKS the workspace marker, so a client that sets it silently gives
    // every app its own module cache — the exact thing the marker prevents.
    h = await harness(true);
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { ...BODY, env: { TELO_CACHE_DIR: "/tmp/mine", KEEP: "yes" } },
    });
    expect(created.statusCode).toBe(201);
    await waitFor(() => h.docker._lastCreateOpts !== null);
    const env = h.docker._lastCreateOpts!.Env;
    expect(env).not.toContain("TELO_CACHE_DIR=/tmp/mine");
    expect(env).toContain("KEEP=yes");
  });

  it("keeps the watch-only surface off a run session", async () => {
    h = await harness(true);
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: BODY,
    });
    const { sessionId } = created.json();
    for (const url of [
      `/v1/sessions/${sessionId}/workspace`,
      `/v1/sessions/${sessionId}/workspace/file?path=telo.yaml`,
    ]) {
      const res = await h.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("not_a_watch_session");
    }
    const reload = await h.app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/reload`,
    });
    expect(reload.statusCode).toBe(409);
  });

  it("reports the app set and its generations on the session document", async () => {
    h = await harness(true);
    const created = await h.app.inject({ method: "POST", url: "/v1/sessions", payload: BODY });
    const { sessionId } = created.json();
    const doc = (await h.app.inject({ method: "GET", url: `/v1/sessions/${sessionId}` })).json();
    // A single-app session is written exactly as before and still names its app,
    // so no client needs two readings.
    expect(doc.mode).toBe("run");
    expect(doc.apps).toEqual([{ name: "app", io: "tty", generation: 0, ports: [] }]);
  });
});

describe("watch session lifetime", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness(true);
  });
  afterEach(async () => {
    await h.app.close();
    await rm(h.bundleRoot, { recursive: true, force: true });
  });

  it("answers 404 on resume for a session that is not suspended", async () => {
    const created = await h.app.inject({ method: "POST", url: "/v1/sessions", payload: BODY });
    const { sessionId } = created.json();
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/resume`,
    });
    // The editor holds the authoritative workspace, so a 404 here costs one
    // change set — it must be an honest 404, never a silently new session.
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_suspended");
  });
});
