import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import { makeFakeDocker, makeRunnerConfig } from "../test-helpers.js";

describe("GET /v1/health", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const handle = await buildServer({
      docker: makeFakeDocker({}),
      runnerConfig: makeRunnerConfig(),
    });
    app = handle.app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns ok true and a version string", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: expect.any(String) });
  });

  it("emits CORS Access-Control-Allow-Origin when a browser origin calls", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { origin: "http://localhost:5173" },
    });
    expect(res.statusCode).toBe(200);
    // With RUNNER_CORS_ORIGINS unset the default is `*`.
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("preflights POST /v1/probe with the CORS allowlist", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/v1/probe",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
  });
});
