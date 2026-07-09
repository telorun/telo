import { describe, expect, it } from "vitest";

import { loadAppsFromEnv, loadResolvedApps, RunnerConfigError } from "./config.js";

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
      title: undefined,
      description: undefined,
    });
  });
});
