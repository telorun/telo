import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_KEYS } from "../../storage-keys";
import { loadRunIndex, saveRunIndex } from "../run-index";

afterEach(() => {
  localStorage.clear();
});

describe("run index", () => {
  it("never stores a runner-minted endpoint token", () => {
    saveRunIndex([
      {
        id: "r1",
        appPath: "app/telo.yaml",
        adapterId: "http-runner",
        adapterDisplayName: "Runner",
        hasTerminal: false,
        startedAt: 1,
        status: {
          kind: "running",
          endpoints: [{ host: "h", port: 8080, protocol: "tcp", token: "secret-a" }],
          agent: { host: "h", port: 8899, protocol: "tcp", url: "http://h:8899", token: "secret-b" },
        },
        config: { baseUrl: "http://runner" },
      },
    ]);

    expect(localStorage.getItem(LOCAL_KEYS.runIndex)).not.toContain("secret-");
    expect(loadRunIndex()[0].status).toEqual({
      kind: "running",
      endpoints: [{ host: "h", port: 8080, protocol: "tcp" }],
      agent: { host: "h", port: 8899, protocol: "tcp", url: "http://h:8899" },
    });
  });
});
