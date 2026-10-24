import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { FakeEngine } from "../docker/fake-engine.test-support.js";
import { bootTestServer } from "../test-server.test-support.js";

describe("POST /v1/probe", () => {
  let app: FastifyInstance;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ app, close } = await bootTestServer());
  });

  afterEach(async () => {
    await close();
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

  // The session config is the runner's vocabulary, not core's, so a config this
  // backend cannot use comes back as something to FIX — a probe's whole job —
  // rather than as a schema rejection from a route that no longer knows the
  // fields.
  it("reports a missing image as needs-setup, naming the field", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/probe",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "needs-setup",
      issues: [{ message: expect.stringMatching(/config\.image/) }],
    });
  });

  it("reports an unknown pullPolicy as needs-setup", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/probe",
      payload: { config: { image: "img", pullPolicy: "sometimes" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "needs-setup",
      issues: [{ message: expect.stringMatching(/pullPolicy/) }],
    });
  });

  it("surfaces probe unavailable responses verbatim", async () => {
    await close();
    const engine = new FakeEngine();
    engine.docker.ping = async () => {
      throw new Error("boom");
    };
    ({ app, close } = await bootTestServer(engine.docker));
    const res = await app.inject({
      method: "POST",
      url: "/v1/probe",
      payload: { config: { image: "img", pullPolicy: "missing" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "unavailable", message: expect.stringMatching(/daemon/i) });
  });
});
