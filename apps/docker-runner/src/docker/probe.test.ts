import { describe, expect, it } from "vitest";

import { makeFakeDocker } from "../test-helpers.js";
import type { ProbeConfig } from "../types.js";
import { runProbe } from "./probe.js";

const RUNNER = { bundleVolume: "telo_bundles", childNetwork: "telo_default" };
const MISSING: ProbeConfig = { image: "telorun/telo:nodejs", pullPolicy: "missing" };
const ALWAYS: ProbeConfig = { image: "telorun/telo:nodejs", pullPolicy: "always" };
const NEVER: ProbeConfig = { image: "telorun/telo:nodejs", pullPolicy: "never" };

describe("runProbe", () => {
  it("returns ready when everything is in order (pullPolicy: missing, image present)", async () => {
    const report = await runProbe(makeFakeDocker({}), RUNNER, MISSING);
    expect(report).toEqual({ status: "ready" });
  });

  it("returns ready when pullPolicy is always (image inspect skipped)", async () => {
    const report = await runProbe(
      makeFakeDocker({ inspectImage: async () => { throw new Error("would 404"); } }),
      RUNNER,
      ALWAYS,
    );
    expect(report).toEqual({ status: "ready" });
  });

  it("returns ready when pullPolicy is missing and image absent (pull is pending)", async () => {
    const report = await runProbe(
      makeFakeDocker({ inspectImage: async () => { throw new Error("404"); } }),
      RUNNER,
      MISSING,
    );
    expect(report).toEqual({ status: "ready" });
  });

  it("returns unavailable when daemon ping fails", async () => {
    const report = await runProbe(
      makeFakeDocker({ ping: async () => { throw new Error("ECONNREFUSED"); } }),
      RUNNER,
      MISSING,
    );
    expect(report.status).toBe("unavailable");
    if (report.status === "unavailable") {
      expect(report.message).toMatch(/daemon/i);
      expect(report.remediation).toMatch(/docker\.sock/i);
    }
  });

  it("returns unavailable when bundle volume is missing", async () => {
    const report = await runProbe(
      makeFakeDocker({ inspectVolume: async () => { throw new Error("no such volume"); } }),
      RUNNER,
      MISSING,
    );
    expect(report.status).toBe("unavailable");
    if (report.status === "unavailable") {
      expect(report.message).toContain("telo_bundles");
      expect(report.remediation).toContain("docker volume create telo_bundles");
    }
  });

  it("returns unavailable when child network is missing", async () => {
    const report = await runProbe(
      makeFakeDocker({ inspectNetwork: async () => { throw new Error("no such network"); } }),
      RUNNER,
      MISSING,
    );
    expect(report.status).toBe("unavailable");
    if (report.status === "unavailable") {
      expect(report.message).toContain("telo_default");
      expect(report.remediation).toMatch(/RUNNER_CHILD_NETWORK|docker network create/);
    }
  });

  it("returns unavailable when pullPolicy is never and image is absent", async () => {
    const report = await runProbe(
      makeFakeDocker({ inspectImage: async () => { throw new Error("404"); } }),
      RUNNER,
      NEVER,
    );
    expect(report.status).toBe("unavailable");
    if (report.status === "unavailable") {
      expect(report.message).toMatch(/not present locally/);
      expect(report.remediation).toContain("docker pull telorun/telo:nodejs");
    }
  });

  it("stages fail in order: daemon beats volume beats network beats image", async () => {
    const report = await runProbe(
      makeFakeDocker({
        ping: async () => { throw new Error("down"); },
        inspectVolume: async () => { throw new Error("also broken"); },
        inspectNetwork: async () => { throw new Error("also broken"); },
      }),
      RUNNER,
      NEVER,
    );
    expect(report.status).toBe("unavailable");
    if (report.status === "unavailable") {
      expect(report.message).toMatch(/daemon/i);
    }
  });
});
