import { describe, expect, it } from "vitest";
import { hostAnswers } from "../src/host-answers.js";
import type { HostFileSystem } from "../src/host-seams.js";
import { HubClient } from "../src/hub-client.js";

/** A workspace of `file:///ws/app/telo.yaml`, `file:///ws/app/routes.yaml` and
 *  an unreadable `file:///ws/locked.yaml`. */
const files: HostFileSystem = {
  stat: async (uri) =>
    ({
      "file:///ws/": "directory",
      "file:///ws/app": "directory",
      "file:///ws/app/": "directory",
      "file:///ws/app/telo.yaml": "file",
      "file:///ws/app/routes.yaml": "file",
      "file:///ws/locked.yaml": "file",
    })[uri] as "file" | "directory" | undefined,
  readText: async (uri) => {
    if (uri === "file:///ws/locked.yaml") throw new Error("EACCES: permission denied");
    return `text of ${uri}`;
  },
  readDirectory: async () => [
    { name: "telo.yaml", kind: "file" },
    { name: "routes.yaml", kind: "file" },
  ],
};
const answers = hostAnswers(
  files,
  async (uri) => ({ uri, text: "remote" }),
  new HubClient({ url: () => "https://hub.test" }),
);

describe("the telo/* answers every host shares", () => {
  it("reads a directory as its telo.yaml, a missing path as null, a failure as an error", async () => {
    expect(await answers["telo/read"]({ uri: "file:///ws/app" })).toEqual({
      uri: "file:///ws/app/telo.yaml",
      text: "text of file:///ws/app/telo.yaml",
    });
    expect(await answers["telo/read"]({ uri: "file:///ws/missing.yaml" })).toBeNull();
    await expect(answers["telo/read"]({ uri: "file:///ws/locked.yaml" })).rejects.toThrow("EACCES");
    expect(await answers["telo/read"]({ uri: "oci://registry.test/lib@1.0.0" })).toEqual({
      uri: "oci://registry.test/lib@1.0.0",
      text: "remote",
    });
  });

  it("resolves exists against the directory of base, and lists only directories", async () => {
    expect(await answers["telo/exists"]({ base: "file:///ws/app/telo.yaml", relative: "routes.yaml" })).toBe(true);
    expect(await answers["telo/exists"]({ base: "file:///ws/app/routes.yaml", relative: "../app" })).toBe(true);
    expect(await answers["telo/exists"]({ base: "file:///ws/app/telo.yaml", relative: "nope.yaml" })).toBe(false);
    expect(await answers["telo/listDirectory"]({ uri: "file:///ws/app/telo.yaml" })).toBeNull();
    expect(await answers["telo/listDirectory"]({ uri: "file:///ws/nothing" })).toBeNull();
    expect(await answers["telo/listDirectory"]({ uri: "file:///ws/app" })).toHaveLength(2);
  });
});
