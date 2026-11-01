import { describe, expect, it } from "vitest";

import { agentContainer, appContainer, workspaceContainer, type SessionContainerArgs } from "./container-spec.js";

const ARGS: SessionContainerArgs = { sessionId: "s1", bundleVolume: "vol", childNetwork: "net", user: { uid: 2000, gid: 2000 } };
const IMAGE = "telorun/node:0-slim";

const containers = {
  workspace: workspaceContainer(ARGS, IMAGE),
  apps: appContainer(ARGS, {
    app: { name: "web", entryRelativePath: "telo.yaml", ports: [] },
    index: 0,
    image: IMAGE,
    token: "token",
    supervisor: { build: "b", subpath: ".supervisor/b" },
    ownsSessionAlias: true,
  }),
  agent: agentContainer(
    ARGS,
    { name: "authoring-agent", source: { kind: "image", image: "acme/agent:1" }, env: {}, pullPolicy: "missing", port: 8080 },
    IMAGE,
  ),
};

describe("every session container", () => {
  it.each(Object.entries(containers))(
    "%s runs as the configured session user, with a writable HOME of its own on the session's directory",
    (owner, opts) => {
      expect(opts.User).toBe("2000:2000");
      expect(opts.Env).toEqual(expect.arrayContaining(["HOME=/home/telo", "npm_config_cache=/home/telo/.npm"]));
      expect(opts.HostConfig.Mounts).toContainEqual({
        Type: "volume",
        Source: "vol",
        Target: "/home/telo",
        VolumeOptions: { Subpath: `s1/home/${owner}` },
      });
    },
  );
});
