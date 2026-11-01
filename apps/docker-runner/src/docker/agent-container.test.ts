import type { RunnerAgent } from "@telorun/runner-core";
import { describe, expect, it } from "vitest";

import { AGENT_MODULE_MOUNT, agentContainer, type SessionContainerArgs } from "./container-spec.js";

const ARGS: SessionContainerArgs = { sessionId: "s1", bundleVolume: "vol", childNetwork: "net", user: { uid: 2000, gid: 2000 } };
const KERNEL = "telorun/node:0-slim";

function agent(source: RunnerAgent["source"]): RunnerAgent {
  return {
    name: "authoring-agent",
    source,
    env: { KEY: "operator" },
    pullPolicy: "missing",
    port: 8080,
  };
}

describe("agentContainer", () => {
  it("runs its own image on its own entry point for an image source", () => {
    const opts = agentContainer(ARGS, agent({ kind: "image", image: "acme/agent:1" }), KERNEL);
    expect(opts.Image).toBe("acme/agent:1");
    expect(opts.Cmd).toBeUndefined();
    expect(opts.HostConfig.Binds).toEqual([]);
  });

  it("runs the kernel image on an oci:// module, fetched at start into the state directory", () => {
    const ref = "oci://ghcr.io/telorun/authoring-agent@1.0.0";
    const opts = agentContainer(ARGS, agent({ kind: "module", ref }), KERNEL);
    expect(opts.Image).toBe(KERNEL);
    expect(opts.Cmd).toEqual(["telo", "run", "--no-input", ref]);
    expect(opts.WorkingDir).toBe("/var/lib/telo-agent-state");
    expect(opts.Env).toContain("TELO_CACHE_DIR=/var/lib/telo-agent-state/telo-cache");
    expect(opts.HostConfig.Binds).toEqual([]);
  });

  it("bind-mounts a host-path module read-only and runs it from there", () => {
    const opts = agentContainer(ARGS, agent({ kind: "module", ref: "/srv/agent" }), KERNEL);
    expect(opts.Image).toBe(KERNEL);
    expect(opts.Cmd).toEqual(["telo", "run", "--no-input", AGENT_MODULE_MOUNT]);
    expect(opts.HostConfig.Binds).toEqual([`/srv/agent:${AGENT_MODULE_MOUNT}:ro`]);
  });
});
