import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../server.js";
import { makeFakeDocker, makeRunnerConfig } from "../test-helpers.js";

describe("GET /v1/capabilities", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv("RUNNER_APPS", "");
    ({ app } = await buildServer({ docker: makeFakeDocker(), runnerConfig: makeRunnerConfig() }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it("advertises the docker-runner capabilities document", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.displayName).toBe("Docker runner");
    expect(body.features).toEqual({ io: true, ports: true });
    // No RUNNER_APPS → no predefined apps advertised.
    expect(body.apps).toBeUndefined();

    const props = body.config.schema.properties;
    expect(props.image.default).toBe("telorun/node:0-slim");
    // docker trusts the caller — image is editable, not readOnly.
    expect(props.image.readOnly).toBeUndefined();
    expect(props.registryUrl).toBeDefined();
  });

  it("advertises app identities only — image and env never surface", async () => {
    vi.stubEnv(
      "RUNNER_APPS",
      '{"tool":{"image":"acme/tool:1","title":"Acme tool","env":{"SERVICE_TOKEN":"tok-secret"}}}',
    );
    const { app: withApps } = await buildServer({
      docker: makeFakeDocker(),
      runnerConfig: makeRunnerConfig(),
    });
    await withApps.ready();
    try {
      const res = await withApps.inject({ method: "GET", url: "/v1/capabilities" });
      // Exact shape: name/title/description only — no image, no env.
      expect(res.json().apps).toEqual([{ name: "tool", title: "Acme tool" }]);
      expect(res.body).not.toContain("tok-secret");
      expect(res.body).not.toContain("acme/tool");
    } finally {
      await withApps.close();
    }
  });
});
