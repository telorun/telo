import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../server.js";
import { makeFakeDocker, makeRunnerConfig } from "../test-helpers.js";

describe("GET /v1/capabilities", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ app } = await buildServer({ docker: makeFakeDocker(), runnerConfig: makeRunnerConfig() }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("advertises the docker-runner capabilities document", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.displayName).toBe("Docker runner");
    expect(body.features).toEqual({ io: true, ports: true });

    const props = body.config.schema.properties;
    expect(props.image.default).toBe("telorun/node:0-slim");
    // docker trusts the caller — image is editable, not readOnly.
    expect(props.image.readOnly).toBeUndefined();
    expect(props.registryUrl).toBeDefined();
  });
});
