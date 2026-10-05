import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer, loadCoreConfig } from "@telorun/runner-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { localRunnerCapabilities, validateLocalRunnerConfig } from "../src/runner/capabilities.js";
import { createProcessBackend } from "../src/runner/process-backend.js";
import { createTeloSupply } from "../src/runner/telo-supply.js";

/**
 * What `telo runner` promises over the wire, checked at the routes rather than
 * at the backend: a client reads `/v1/capabilities` and the runner has to
 * enforce exactly that. No session is started here — every case below is
 * refused or answered before anything spawns.
 */

let app: FastifyInstance;
let stateRoot: string;
/** What the release host answers, by URL suffix; anything else is a 404. */
let release: Record<string, { status: number; body: string }>;

beforeEach(async () => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telo-runner-test-"));
  release = {};
  const base = loadCoreConfig({}, { port: 8061 });
  const built = await buildServer({
    backend: createProcessBackend({
      stateRoot,
      telo: createTeloSupply({
        identity: "0.50.0+unreleased",
        hostTarget: "linux-amd64-gnu",
        cacheRoot: path.join(stateRoot, "binaries"),
        fetch: async (input) => {
          const url = String(input);
          const hit = Object.entries(release).find(([suffix]) => url.endsWith(suffix));
          return new Response(hit?.[1].body ?? "", { status: hit?.[1].status ?? 404 });
        },
      }),
    }),
    config: {
      ...base,
      logLevel: "silent",
      // What `telo runner` serves: no browser origin unless one was named.
      corsOrigins: [],
      watch: { ...base.watch, enabled: true },
    },
    version: "test",
    capabilities: localRunnerCapabilities({ watch: true }),
    validateConfig: validateLocalRunnerConfig,
  });
  app = built.app;
  await app.ready();
});

afterEach(async () => {
  await app.close();
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

const bundle = {
  entryRelativePath: "telo.yaml",
  files: [{ relativePath: "telo.yaml", contents: "kind: Telo.Application\n" }],
};

describe("telo runner capabilities", () => {
  it("advertises streams-only io and no editable config", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      config: { schema: { properties: {} } },
      features: { io: ["streams"], ports: true, watch: true, teloVersions: true },
    });
    // No image, no pull policy: a field that changes nothing has no business on
    // the editor's form.
    expect(Object.keys(res.json().config.schema.properties)).toEqual([]);
  });

  it("reports ready without a config, because it has none to check", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/probe", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready" });
  });
});

describe("io negotiation", () => {
  it("refuses an explicit tty rather than downgrading it silently", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        bundle,
        env: {},
        apps: [{ name: "app", entryRelativePath: "telo.yaml", io: "tty" }],
      },
    });
    // `isatty()` is observable to the application, so handing back a session
    // that claims a terminal it does not have is the one outcome worth refusing.
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "io_unsupported" });
    expect(res.json().message).toMatch(/streams/);
  });
});

describe("an application naming its telo version", () => {
  const asking = (telo: string) =>
    app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { bundle, env: {}, apps: [{ name: "app", entryRelativePath: "telo.yaml", telo }] },
    });

  /** The session's status once its start has settled as a failure. */
  async function failedStart(telo: string): Promise<string> {
    const res = await asking(telo);
    expect(res.statusCode).toBe(201);
    const { sessionId } = res.json() as { sessionId: string };
    for (let i = 0; i < 200; i++) {
      const status = (await app.inject({ method: "GET", url: `/v1/sessions/${sessionId}` })).json()
        .status as { kind: string; message?: string };
      if (status.kind === "failed") return status.message ?? "";
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("the session never reported its failed start");
  }

  // What is certain without the network is refused before a session exists.
  it("refuses another build's unreleased identity, which no release can stand in for", async () => {
    const res = await asking("0.110.0+unreleased");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "telo_version_unavailable", app: "app", version: "0.110.0+unreleased" });
    expect(res.json().reason).toMatch(/unreleased build, which only the build it came from can run/);
    expect(res.json().reason).toMatch(/Pin a released telo version/);
  });

  it("refuses text that is not a version before asking for anything", async () => {
    const res = await asking("latest");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_telo_version" });
  });

  // A release this machine does not hold is fetched by the session's start, so
  // its failure is that session's — carrying the same reason.
  it("fails the start for a release that publishes no binary, naming the version and the cause", async () => {
    expect(await failedStart("0.105.0")).toMatch(
      /telo 0\.105\.0 publishes no binary for linux-amd64-gnu \(HTTP 404/,
    );
  });

  it("fails the start for a download the release host fails, with its status", async () => {
    release["telo-0.105.0-linux-amd64-gnu.tar.gz"] = { status: 503, body: "" };
    expect(await failedStart("0.105.0")).toMatch(/HTTP 503/);
  });

  it("fails the start for a binary the release publishes no checksum for", async () => {
    release["telo-0.105.0-linux-amd64-gnu.tar.gz"] = { status: 200, body: "bytes" };
    expect(await failedStart("0.105.0")).toMatch(/no checksums\.txt published/);
  });

  it("fails the start for a binary whose checksum does not match", async () => {
    release["telo-0.105.0-linux-amd64-gnu.tar.gz"] = { status: 200, body: "bytes" };
    release["checksums.txt"] = { status: 200, body: `${"0".repeat(64)}  telo-0.105.0-linux-amd64-gnu.tar.gz\n` };
    expect(await failedStart("0.105.0")).toMatch(/checksum mismatch/);
  });

  it("leaves no session directory behind a start that could not get its telo", async () => {
    await failedStart("0.105.0");
    const left = fs.readdirSync(stateRoot).filter((name) => name !== "binaries");
    expect(left).toEqual([]);
  });
});

describe("browser origins", () => {
  it("refuses a request from an origin it was not given", async () => {
    // Every page the user visits can reach 127.0.0.1, and this API runs code —
    // so an unnamed origin is refused by the runner itself rather than left to
    // the browser's own CORS rule.
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { origin: "https://evil.example" },
      payload: { bundle, env: {} },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "origin_not_allowed" });
  });

  it("leaves a request with no Origin alone", async () => {
    // A CLI, a script or a health check sends none; what bounds those is the
    // loopback bind, not this.
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
  });
});

describe("session config", () => {
  it("refuses a config key it advertises no room for", async () => {
    // The closed schema on /v1/capabilities constrains the editor; this is what
    // holds a client that skipped it to the same answer.
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { bundle, env: {}, config: { image: "telorun/node:0-slim" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_config" });
    expect(res.json().message).toMatch(/image/);
  });

  it("accepts a start with no config at all", async () => {
    // The container backends require an image; this one has no fields, and the
    // contract no longer insists on the object either.
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { bundle, env: {} },
    });
    expect(res.statusCode).toBe(201);
    const { sessionId } = res.json();
    await app.inject({ method: "DELETE", url: `/v1/sessions/${sessionId}` });
  });
});
