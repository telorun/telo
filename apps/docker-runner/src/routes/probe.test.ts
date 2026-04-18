import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../server.js";
import { makeFakeDocker, makeRunnerConfig, type FakeDockerBehavior } from "../test-helpers.js";

async function buildApp(behavior: FakeDockerBehavior = {}): Promise<FastifyInstance> {
  const { app } = await buildServer({
    docker: makeFakeDocker(behavior),
    runnerConfig: makeRunnerConfig(),
  });
  await app.ready();
  return app;
}

describe("POST /v1/probe", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns ready on the happy path", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/probe",
      payload: { config: { image: "telorun/telo:nodejs", pullPolicy: "missing" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready" });
  });

  it("rejects bodies missing the config field with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/probe",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects unknown pullPolicy values with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/probe",
      payload: { config: { image: "img", pullPolicy: "sometimes" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("surfaces probe unavailable responses verbatim", async () => {
    await app.close();
    app = await buildApp({
      ping: async () => {
        throw new Error("boom");
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/probe",
      payload: { config: { image: "img", pullPolicy: "missing" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "unavailable", message: expect.stringMatching(/daemon/i) });
  });
});
