import { afterEach, describe, expect, it, vi } from "vitest";

import { bootTestServer } from "../test-server.test-support.js";

describe("GET /v1/capabilities", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("advertises the docker-runner capabilities document", async () => {
    const server = await bootTestServer();
    try {
      const res = await server.app.inject({ method: "GET", url: "/v1/capabilities" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.displayName).toBe("Docker runner");
      expect(body.features).toEqual({ io: ["tty", "streams"], ports: true, teloVersions: true });
      const props = body.config.schema.properties;
      expect(props.image.default).toBe("telorun/node:0-slim");
      // docker trusts the caller — image is editable, not readOnly.
      expect(props.image.readOnly).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("advertises the agent by name only — its image and env never surface", async () => {
    vi.stubEnv("AGENT_IMAGE", "acme/agent:1");
    vi.stubEnv("AGENT_PORT", "8080");
    vi.stubEnv("AGENT_ENV", JSON.stringify({ SERVICE_TOKEN: "tok-secret" }));
    const server = await bootTestServer();
    try {
      const res = await server.app.inject({ method: "GET", url: "/v1/capabilities" });
      expect(res.json().features.agents).toEqual(["authoring-agent"]);
      expect(res.body).not.toContain("tok-secret");
      expect(res.body).not.toContain("acme/agent");
    } finally {
      await server.close();
    }
  });
});
