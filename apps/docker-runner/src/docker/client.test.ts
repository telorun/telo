import { describe, expect, it } from "vitest";

import { apiVersionAtLeast, refuseDaemonWithoutSubpath } from "./client.js";

describe("apiVersionAtLeast", () => {
  it("compares dotted versions numerically, not as strings", () => {
    expect(apiVersionAtLeast("1.45", "1.45")).toBe(true);
    expect(apiVersionAtLeast("1.47", "1.45")).toBe(true);
    expect(apiVersionAtLeast("1.9", "1.45")).toBe(false);
    expect(apiVersionAtLeast("2.0", "1.45")).toBe(true);
  });
});

describe("the boot refusal of a daemon without Subpath", () => {
  it("passes a daemon at or above Engine API 1.45", async () => {
    await expect(refuseDaemonWithoutSubpath({ version: async () => ({ ApiVersion: "1.45" }) })).resolves.toBeUndefined();
  });

  it("refuses an older daemon, one reporting no version, and one that cannot be asked, naming Docker 26", async () => {
    await expect(refuseDaemonWithoutSubpath({ version: async () => ({ ApiVersion: "1.44" }) })).rejects.toThrow(
      /needs Docker Engine API 1\.45 or newer \(Docker 26\+\), and this daemon reports API 1\.44\./,
    );
    await expect(refuseDaemonWithoutSubpath({ version: async () => ({}) })).rejects.toThrow(
      /this daemon reports no readable API version/,
    );
    await expect(
      refuseDaemonWithoutSubpath({
        version: async () => {
          throw new Error("connect ENOENT /var/run/docker.sock");
        },
      }),
    ).rejects.toThrow(/could not be asked for its version \(connect ENOENT .*Docker 26\+/);
  });
});
