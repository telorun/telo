import { describe, expect, it } from "vitest";

import { AGENT_NAME, loadAgentFromEnv, loadAgentFromObject, RunnerConfigError } from "./config.js";

const IMAGE = { AGENT_IMAGE: "acme/agent:1", AGENT_PORT: "8080" };

describe("loadAgentFromEnv", () => {
  it("returns undefined when no agent variable is set", () => {
    expect(loadAgentFromEnv({})).toBeUndefined();
  });

  it("reads an image source with its defaults", () => {
    expect(loadAgentFromEnv(IMAGE)).toEqual({
      name: AGENT_NAME,
      source: { kind: "image", image: "acme/agent:1" },
      env: {},
      pullPolicy: "missing",
      port: 8080,
    });
  });

  it("reads a module ref source, both oci:// and an absolute host path", () => {
    const oci = loadAgentFromEnv({ AGENT_MODULE_REF: "oci://ghcr.io/telorun/authoring-agent@1.0.0", AGENT_PORT: "8080" });
    expect(oci?.source).toEqual({ kind: "module", ref: "oci://ghcr.io/telorun/authoring-agent@1.0.0" });
    const host = loadAgentFromEnv({ AGENT_MODULE_REF: "/srv/agent", AGENT_PORT: "8080" });
    expect(host?.source).toEqual({ kind: "module", ref: "/srv/agent" });
  });

  it("reads the plain env, token variable, title and description", () => {
    const agent = loadAgentFromEnv({
      ...IMAGE,
      AGENT_ENV: JSON.stringify({ ANTHROPIC_API_KEY: "sk" }),
      AGENT_PULL_POLICY: "always",
      AGENT_TOKEN_ENV: "AGENT_TOKEN",
      AGENT_TITLE: "Authoring agent",
      AGENT_DESCRIPTION: "Writes manifests",
    });
    expect(agent).toMatchObject({
      env: { ANTHROPIC_API_KEY: "sk" },
      pullPolicy: "always",
      tokenEnv: "AGENT_TOKEN",
      title: "Authoring agent",
      description: "Writes manifests",
    });
  });

  it("refuses an agent that names both or neither source", () => {
    expect(() => loadAgentFromEnv({ ...IMAGE, AGENT_MODULE_REF: "/srv/agent" })).toThrow(
      /AGENT_IMAGE and AGENT_MODULE_REF are both set/,
    );
    expect(() => loadAgentFromEnv({ AGENT_PORT: "8080", AGENT_TITLE: "x" })).toThrow(
      /AGENT_PORT, AGENT_TITLE are set, but the agent is configured by AGENT_IMAGE or AGENT_MODULE_REF/,
    );
  });

  it("requires a port and rejects one that is not a usable tcp port", () => {
    expect(() => loadAgentFromEnv({ AGENT_IMAGE: "i" })).toThrow(/AGENT_PORT is required/);
    for (const bad of ["0", "65536", "8080.5", "http"]) {
      expect(() => loadAgentFromEnv({ AGENT_IMAGE: "i", AGENT_PORT: bad })).toThrow(RunnerConfigError);
    }
  });

  it("rejects a module ref that is neither oci:// nor absolute", () => {
    expect(() => loadAgentFromEnv({ AGENT_MODULE_REF: "agent/telo.yaml", AGENT_PORT: "8080" })).toThrow(
      /must be an oci:\/\/ reference or an absolute host path/,
    );
  });

  it("rejects malformed AGENT_ENV, pullPolicy and token variable", () => {
    expect(() => loadAgentFromEnv({ ...IMAGE, AGENT_ENV: "{nope" })).toThrow(/AGENT_ENV is not valid JSON/);
    expect(() => loadAgentFromEnv({ ...IMAGE, AGENT_ENV: '{"A":1}' })).toThrow(/string values/);
    expect(() => loadAgentFromEnv({ ...IMAGE, AGENT_PULL_POLICY: "sometimes" })).toThrow(/AGENT_PULL_POLICY/);
    expect(() => loadAgentFromEnv({ ...IMAGE, AGENT_TOKEN_ENV: "AGENT-TOKEN" })).toThrow(/AGENT_TOKEN_ENV/);
  });

  it("reports a missing source or port before a malformed AGENT_ENV", () => {
    expect(() => loadAgentFromEnv({ AGENT_ENV: "nope" })).toThrow(
      /the agent is configured by AGENT_IMAGE or AGENT_MODULE_REF/,
    );
    expect(() => loadAgentFromEnv({ AGENT_IMAGE: "i", AGENT_ENV: "nope" })).toThrow(/AGENT_PORT is required/);
  });

  it("refuses a token variable the agent's own env also sets", () => {
    expect(() =>
      loadAgentFromEnv({
        ...IMAGE,
        AGENT_ENV: JSON.stringify({ AGENT_TOKEN: "x" }),
        AGENT_TOKEN_ENV: "AGENT_TOKEN",
      }),
    ).toThrow(/AGENT_TOKEN_ENV is 'AGENT_TOKEN', which AGENT_ENV also defines/);
  });
});

describe("loadAgentFromObject", () => {
  const FILE = "/etc/telo/agent/agent.yaml";
  const load = (value: unknown, env: NodeJS.ProcessEnv = {}) => loadAgentFromObject(value, { file: FILE, env });

  it("reads the file's settings, an empty string as absent, each secret from its AGENT_SECRET_ variable", () => {
    const agent = load(
      {
        moduleRef: "oci://ghcr.io/telorun/authoring-agent@1.0.0",
        port: 8080,
        pullPolicy: "",
        tokenEnv: "AGENT_TOKEN",
        title: "Authoring agent",
        env: { MODEL: "opus" },
        secretEnv: ["ANTHROPIC_API_KEY"],
      },
      { AGENT_SECRET_ANTHROPIC_API_KEY: "sk-secret" },
    );
    expect(agent).toEqual({
      name: AGENT_NAME,
      source: { kind: "module", ref: "oci://ghcr.io/telorun/authoring-agent@1.0.0" },
      env: { MODEL: "opus", ANTHROPIC_API_KEY: "sk-secret" },
      pullPolicy: "missing",
      port: 8080,
      tokenEnv: "AGENT_TOKEN",
      title: "Authoring agent",
    });
  });

  it("refuses a key it does not read, naming the file", () => {
    expect(() => load({ image: "acme/agent:1", port: 8080, resources: {} })).toThrow(
      "`resources` in /etc/telo/agent/agent.yaml is not an agent setting (expected one of: image, moduleRef, port, pullPolicy, tokenEnv, title, description, env, secretEnv).",
    );
  });

  it("refuses a secret whose variable is unset", () => {
    expect(() => load({ image: "acme/agent:1", port: 8080, secretEnv: ["API_KEY"] })).toThrow(
      "`secretEnv` in /etc/telo/agent/agent.yaml lists 'API_KEY', but AGENT_SECRET_API_KEY is unset: the runner reads the secret's value from it.",
    );
  });

  it("refuses a variable both env and secretEnv define, and a token variable either defines", () => {
    const env = { AGENT_SECRET_KEY: "s" };
    expect(() => load({ image: "i", port: 8080, env: { KEY: "p" }, secretEnv: ["KEY"] }, env)).toThrow(
      "'KEY' is defined by both `env` in /etc/telo/agent/agent.yaml and `secretEnv` in /etc/telo/agent/agent.yaml — define it once.",
    );
    expect(() => load({ image: "i", port: 8080, tokenEnv: "KEY", secretEnv: ["KEY"] }, env)).toThrow(
      /^`tokenEnv` in \S+ is 'KEY', which `secretEnv` in \S+ also defines/,
    );
  });

  it("validates as the variables do, naming the file's keys", () => {
    expect(() => load({ image: "i" })).toThrow("`port` in /etc/telo/agent/agent.yaml is required");
    expect(() => load({ image: "i", moduleRef: "oci://x" })).toThrow(/^`image` in \S+ and `moduleRef` in \S+ are both set/);
    expect(() => load({ port: 8080 })).toThrow(/^`port` in \S+ is set, but the agent is configured by `image` in/);
    expect(() => load({ image: "i", port: true })).toThrow("`port` in /etc/telo/agent/agent.yaml must be an integer in 1..65535.");
    expect(() => load({ image: "i", port: 8080, env: { A: 1 } })).toThrow(/^`env` in \S+ must be a map of string values/);
  });
});
