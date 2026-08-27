import { describe, expect, it } from "vitest";

import {
  coResidentAgentNames,
  loadAppsFromEnv,
  loadResolvedApps,
  RunnerConfigError,
} from "./config.js";

describe("loadAppsFromEnv", () => {
  it("returns undefined when RUNNER_APPS is unset (no apps offered)", () => {
    expect(loadAppsFromEnv({})).toBeUndefined();
  });

  it("parses a valid catalog", () => {
    const catalog = loadAppsFromEnv({
      RUNNER_APPS: JSON.stringify({
        tool: {
          image: "acme/tool:1.2.0",
          env: { SERVICE_TOKEN: "tok-op" },
          pullPolicy: "never",
        },
      }),
    })!;
    expect(catalog.tool.image).toBe("acme/tool:1.2.0");
    expect(catalog.tool.env).toEqual({ SERVICE_TOKEN: "tok-op" });
  });

  it("rejects malformed JSON and invalid entries loudly", () => {
    expect(() => loadAppsFromEnv({ RUNNER_APPS: "{nope" })).toThrow(RunnerConfigError);
    expect(() => loadAppsFromEnv({ RUNNER_APPS: '{"x":{}}' })).toThrow(/needs a non-empty string 'image'/);
    expect(() => loadAppsFromEnv({ RUNNER_APPS: '{"x":{"image":"i","env":["nope"]}}' })).toThrow(
      /invalid 'env'/,
    );
    expect(() =>
      loadAppsFromEnv({ RUNNER_APPS: '{"x":{"image":"i","pullPolicy":"sometimes"}}' }),
    ).toThrow(/pullPolicy/);
  });

  it("accepts a port and rejects one that is not a usable tcp port", () => {
    const catalog = loadAppsFromEnv({
      RUNNER_APPS: '{"agent":{"image":"i","port":8080}}',
    })!;
    expect(catalog.agent.port).toBe(8080);
    for (const bad of ["0", "65536", '"8080"', "8080.5"]) {
      expect(() =>
        loadAppsFromEnv({ RUNNER_APPS: `{"agent":{"image":"i","port":${bad}}}` }),
      ).toThrow(/invalid 'port'/);
    }
  });
});

describe("loadResolvedApps", () => {
  it("is empty when RUNNER_APPS is unset", () => {
    expect(loadResolvedApps({})).toEqual({});
  });

  it("applies defaults to the configured catalog", () => {
    const resolved = loadResolvedApps({
      RUNNER_APPS: '{"tool":{"image":"acme/tool:1"}}',
    });
    expect(resolved.tool).toEqual({
      name: "tool",
      image: "acme/tool:1",
      env: {},
      pullPolicy: "missing",
      port: undefined,
      title: undefined,
      description: undefined,
    });
  });

  // No default: the catalog is operator configuration and the runner knows
  // nothing about any specific app, so a port it did not declare is absent
  // rather than guessed — which is what makes `agent_port_undeclared` possible.
  it("leaves an undeclared port undefined and carries a declared one", () => {
    const resolved = loadResolvedApps({
      RUNNER_APPS: '{"plain":{"image":"a"},"agent":{"image":"b","port":8080}}',
    });
    expect(resolved.plain.port).toBeUndefined();
    expect(resolved.agent.port).toBe(8080);
  });
});

describe("coResidentAgentNames", () => {
  it("names only the entries a session would accept as an agent", () => {
    // The advertised set IS the acceptance condition. Deriving it here rather
    // than in each runner is what stops the two drifting the next time the
    // condition grows — which is exactly how a port-less catalog came to be
    // advertised and then refused on every run.
    const apps = loadResolvedApps({
      RUNNER_APPS: '{"agent":{"image":"a","port":8080},"tool":{"image":"b"}}',
    });
    expect(coResidentAgentNames(apps)).toEqual(["agent"]);
  });

  it("is empty for a catalog predating the port field", () => {
    expect(coResidentAgentNames(loadResolvedApps({ RUNNER_APPS: '{"tool":{"image":"b"}}' }))).toEqual(
      [],
    );
  });
});
