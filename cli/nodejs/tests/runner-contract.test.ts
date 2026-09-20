import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer, loadCoreConfig } from "@telorun/runner-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { localRunnerCapabilities, validateLocalRunnerConfig } from "../src/runner/capabilities.js";
import { createProcessBackend } from "../src/runner/process-backend.js";

/**
 * What `telo runner` promises over the wire, checked at the routes rather than
 * at the backend: a client reads `/v1/capabilities` and the runner has to
 * enforce exactly that. No session is started here — every case below is
 * refused or answered before anything spawns.
 */

let app: FastifyInstance;
let stateRoot: string;

beforeEach(async () => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telo-runner-test-"));
  const base = loadCoreConfig({}, { port: 8061 });
  const built = await buildServer({
    backend: createProcessBackend({ stateRoot }),
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
      features: { io: ["streams"], ports: true, watch: true },
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
