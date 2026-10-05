import { describe, expect, it } from "vitest";

import type { RunnerBackend } from "./backend.js";
import { loadCoreConfig } from "./config.js";
import {
  isUnreleasedTelo,
  MIN_SUPERVISABLE_TELO,
  unsupervisableTelo,
  type RunnerCapabilities,
} from "./contract.js";
import { buildServer } from "./server.js";

const config = { ...loadCoreConfig({}, { port: 8061 }), logLevel: "silent" };

const capabilities = (teloVersions: boolean): RunnerCapabilities => ({
  displayName: "Test runner",
  description: "",
  config: { schema: { type: "object", properties: {} } },
  features: { io: ["streams"], ports: true, watch: false, ...(teloVersions ? { teloVersions } : {}) },
});

const backend = (extra: Partial<RunnerBackend> = {}): RunnerBackend => ({
  probe: async () => ({ status: "ready" }),
  start: async () => {
    throw new Error("no session is started by these cases");
  },
  ...extra,
});

const bundle = {
  entryRelativePath: "telo.yaml",
  files: [{ relativePath: "telo.yaml", contents: "kind: Telo.Application\n" }],
};

describe("a runner advertising telo versions", () => {
  it("is refused at build over a backend that cannot be asked for one", async () => {
    await expect(
      buildServer({ backend: backend(), config, version: "test", capabilities: capabilities(true) }),
    ).rejects.toThrow(/features\.teloVersions.*supplyTelo/);
  });

  it("refuses a release older than the oldest it is verified to supervise, before asking the backend", async () => {
    const asked: string[] = [];
    const { app } = await buildServer({
      backend: backend({
        supplyTelo: async (version) => {
          asked.push(version);
          return undefined;
        },
      }),
      config,
      version: "test",
      capabilities: capabilities(true),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { bundle, env: {}, telo: "0.94.9" },
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "telo_version_unavailable", version: "0.94.9" });
    expect(res.json().reason).toContain(MIN_SUPERVISABLE_TELO);
    expect(asked).toEqual([]);
  });
});

describe("a runner that does not advertise telo versions", () => {
  it("answers a named version as unsupported, not as a complaint about its config", async () => {
    const { app } = await buildServer({
      backend: backend(),
      config,
      version: "test",
      capabilities: capabilities(false),
      // A gate that would refuse the config of a version-naming request.
      validateConfig: (sessionConfig, request) => (request.telo ? "config beside a version" : undefined),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { bundle, env: {}, telo: "0.105.0", config: { image: "x" } },
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "telo_version_unsupported" });
  });
});

describe("the version floor and the unreleased identity", () => {
  it("compares by release number, ignoring a build tag", () => {
    expect(unsupervisableTelo(MIN_SUPERVISABLE_TELO)).toBeUndefined();
    expect(unsupervisableTelo("0.108.0+unreleased")).toBeUndefined();
    expect(unsupervisableTelo("1.0.0")).toBeUndefined();
    expect(unsupervisableTelo("0.9.0")).toMatch(/older than/);
  });

  it("tells a build identity from a release", () => {
    expect(isUnreleasedTelo("0.108.0+unreleased")).toBe(true);
    expect(isUnreleasedTelo("0.108.0")).toBe(false);
  });
});
