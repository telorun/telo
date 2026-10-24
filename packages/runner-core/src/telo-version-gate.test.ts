import { afterEach, describe, expect, it } from "vitest";

import type { RunnerBackend } from "./backend.js";
import { loadCoreConfig } from "./config.js";
import {
  isUnreleasedTelo,
  MIN_SUPERVISABLE_TELO,
  unsupervisableTelo,
  type RunnerCapabilities,
} from "./contract.js";
import { buildServer } from "./server.js";
import { FakeWorkloadBackend, temporaryStore } from "./test-support/fake-workload-backend.js";

const config = { ...loadCoreConfig({}, { port: 8061 }), logLevel: "silent" };

const capabilities = (teloVersions: boolean): RunnerCapabilities => ({
  displayName: "Test runner",
  description: "",
  config: { schema: { type: "object", properties: {} } },
  features: { io: ["streams"], ports: true, ...(teloVersions ? { teloVersions } : {}) },
});

const backend = (supplyTelo?: RunnerBackend["supplyTelo"]): FakeWorkloadBackend =>
  Object.assign(new FakeWorkloadBackend(), supplyTelo ? { supplyTelo } : {});

const appOn = (telo: string) => [{ name: "app", entryRelativePath: "telo.yaml", telo }];

const stores: Array<Awaited<ReturnType<typeof temporaryStore>>> = [];
async function store() {
  const handle = await temporaryStore();
  stores.push(handle);
  return handle.store;
}
afterEach(async () => {
  for (const handle of stores.splice(0)) await handle.dispose();
});

describe("a runner advertising telo versions", () => {
  it("is refused at build over a backend that cannot be asked for one", async () => {
    await expect(
      buildServer({
        backend: backend(),
        config,
        version: "test",
        capabilities: capabilities(true),
        store: await store(),
      }),
    ).rejects.toThrow(/features\.teloVersions.*supplyTelo/);
  });

  it("refuses a release older than the oldest it is verified to supervise, before asking the backend", async () => {
    const asked: string[] = [];
    const { app } = await buildServer({
      backend: backend(async (version) => {
        asked.push(version);
        return undefined;
      }),
      store: await store(),
      config,
      version: "test",
      capabilities: capabilities(true),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspace: "w", apps: appOn("0.122.0") },
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "telo_version_unavailable", version: "0.122.0" });
    expect(res.json().reason).toContain(MIN_SUPERVISABLE_TELO);
    expect(asked).toEqual([]);
  });
});

describe("a runner that does not advertise telo versions", () => {
  it("answers a named version as unsupported, not as a complaint about its config", async () => {
    const { app } = await buildServer({
      backend: backend(),
      store: await store(),
      config,
      version: "test",
      capabilities: capabilities(false),
      // A gate that would refuse the config of a version-naming request.
      validateConfig: (sessionConfig, request) => (request.telo ? "config beside a version" : undefined),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspace: "w", apps: appOn("0.105.0"), config: { image: "x" } },
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "telo_version_unsupported" });
  });
});

describe("the version floor and the unreleased identity", () => {
  it("compares by release number, ignoring a build tag", () => {
    expect(unsupervisableTelo(MIN_SUPERVISABLE_TELO)).toBeUndefined();
    expect(unsupervisableTelo("0.123.0+unreleased")).toBeUndefined();
    expect(unsupervisableTelo("0.122.0")).toMatch(/older than 0\.123\.0/);
    expect(unsupervisableTelo("1.0.0")).toBeUndefined();
    expect(unsupervisableTelo("0.9.0")).toMatch(/older than/);
  });

  it("tells a build identity from a release", () => {
    expect(isUnreleasedTelo("0.108.0+unreleased")).toBe(true);
    expect(isUnreleasedTelo("0.108.0")).toBe(false);
  });
});
