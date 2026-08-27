import { describe, expect, it } from "vitest";

import { apiVersionAtLeast, watchSupportedByDaemon, MIN_WATCH_API_VERSION } from "./client.js";
import { sessionWorkspaceMount } from "./watch-session.js";

describe("apiVersionAtLeast", () => {
  it("compares dotted versions numerically, not as strings", () => {
    // The string comparison this replaces reads "1.9" as newer than "1.45",
    // which would disable watch on every daemon that actually supports it.
    expect(apiVersionAtLeast("1.45", "1.45")).toBe(true);
    expect(apiVersionAtLeast("1.46", "1.45")).toBe(true);
    expect(apiVersionAtLeast("1.9", "1.45")).toBe(false);
    expect(apiVersionAtLeast("1.44", "1.45")).toBe(false);
    expect(apiVersionAtLeast("2.0", "1.45")).toBe(true);
  });
});

describe("watchSupportedByDaemon", () => {
  it("accepts a daemon at or above the floor", async () => {
    expect(await watchSupportedByDaemon({ version: async () => ({ ApiVersion: "1.45" }) } as never)).toEqual(
      { supported: true, apiVersion: "1.45" },
    );
  });

  it("refuses a daemon below the floor and reports what it found", async () => {
    // Below 1.45 the daemon IGNORES the subpath and mounts the volume whole at
    // /workspace — every session's files in every container, at a path that
    // looks right. Refusing is the only safe reading of that.
    expect(await watchSupportedByDaemon({ version: async () => ({ ApiVersion: "1.44" }) } as never)).toEqual(
      { supported: false, apiVersion: "1.44" },
    );
  });

  it("refuses when the daemon cannot be asked", async () => {
    // No evidence is not evidence of support: watch is the capability that
    // needs the guarantee, so an unreachable daemon answers no.
    const unreachable = {
      version: async () => {
        throw new Error("socket closed");
      },
    };
    expect(await watchSupportedByDaemon(unreachable as never)).toEqual({ supported: false });
  });

  it("refuses when the daemon reports no version string", async () => {
    expect(await watchSupportedByDaemon({ version: async () => ({}) } as never)).toEqual({
      supported: false,
    });
  });

  it("names a floor the running daemon family actually reaches", () => {
    expect(MIN_WATCH_API_VERSION).toBe("1.45");
  });
});

describe("sessionWorkspaceMount", () => {
  const mount = sessionWorkspaceMount("telo_bundles", "exdnf2cr5g4g");

  it("mounts the session's own workspace at the path kubernetes uses", () => {
    // The whole point of the change: an application sees `/workspace/telo.yaml`
    // on both backends, with no session id anywhere in the path.
    expect(mount.Target).toBe("/workspace");
    expect(mount.VolumeOptions?.Subpath).toBe("exdnf2cr5g4g/workspace");
  });

  it("scopes to the workspace, not the session directory", () => {
    // The file service's own manifest and the module cache are SIBLINGS of
    // `workspace/`. Mounting the session directory would put both inside the
    // user's workspace, where they would show up in the file tree and in the
    // agent's view of the project.
    expect(mount.VolumeOptions?.Subpath).not.toBe("exdnf2cr5g4g");
  });

  it("never mounts over /srv", () => {
    // An operator catalog image may install itself anywhere, and the authoring
    // agent installs itself under /srv. Mounting there covered up the image's
    // own files, which is why the agent could not start on docker.
    expect(mount.Target).not.toBe("/srv");
  });
});
